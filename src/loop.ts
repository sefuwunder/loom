/* loop.ts — the react loop. One durable thought, executed in bounded turns.
   Every turn: build bounded context -> think (ephemeral worker) -> execute one
   action -> ledger -> spin-check. Nothing accumulates in RAM. */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb, addLedger, recordStep, getKv, setKv, type Job } from "./db";
import { buildContext, getContextBudget } from "./context";
import { fingerprint, observe, emptySpin, replanPrompt, MAX_STRIKES, type SpinState } from "./spin";
import { think, thinkTimeout, hashText, type ThinkAction } from "./think";
import { runExec } from "./exec";
import { getEmbedder, indexChunk, recall, type Embedder } from "./vector";

const STALE_HEARTBEAT_S = 300;
const WRITE_CAP = 200 * 1024;
const READ_CAP = 32 * 1024;

export interface WorkOpts {
  once?: boolean;
  thinkerDefault?: string;
}

/** Rebuild spin state from the persisted step trail (crash-safe). */
function loadSpin(db: Database, jobId: string): SpinState {
  const rows = db.query(`SELECT fingerprint, output_hash FROM steps WHERE job_id = ? ORDER BY seq DESC LIMIT 32`)
    .all(jobId) as Array<{ fingerprint: string; output_hash: string }>;
  const s = emptySpin();
  if (!rows.length) return s;
  s.lastFp = rows[0].fingerprint;
  s.lastOutputHash = rows[0].output_hash;
  for (const r of rows) {
    if (r.fingerprint === s.lastFp && r.output_hash === s.lastOutputHash) s.repeatCount++;
    else break;
  }
  return s;
}

function touch(db: Database, job: Job): void {
  db.query(`UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ?`).run(Date.now(), Date.now(), job.id);
}

function setStatus(db: Database, job: Job, status: Job["status"], result?: string): void {
  db.query(`UPDATE jobs SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?`)
    .run(status, result ?? null, Date.now(), job.id);
  job.status = status;
}

function outbox(db: Database, jobId: string, kind: string, text: string): void {
  db.query(`INSERT INTO outbox (job_id, kind, text, created_at) VALUES (?, ?, ?, ?)`)
    .run(jobId, kind, text, Date.now());
}

/** Execute one thinker action. Returns the observation text for the ledger. */
/** Execute one thinker action. Exported for tests. */
export async function executeAction(
  db: Database, job: Job, a: ThinkAction, logDir: string, embedder: Embedder,
  index: (kind: string, ref: string, text: string) => Promise<void>,
): Promise<{ text: string; outputHash: string; failed: boolean }> {
  const fail = (text: string) => ({ text, outputHash: hashText("fail:" + text), failed: true });
  const refOf = (s: string) => s.slice(0, 80);
  try {
    switch (a.action) {
      case "exec": {
        if (!a.cmd) return fail("exec needs cmd");
        const r = await runExec(a.cmd, { timeout_s: a.timeout_s ?? 120, logDir });
        recordStep(db, job.id, "exec", { cmd: a.cmd, label: a.label }, fingerprint(a),
          r.timedOut || r.code !== 0 ? "failed" : "done",
          `exit=${r.timedOut ? "TIMEOUT" : r.code} ms=${r.ms}\n` + r.head, r.outputHash, r.logPath, r.ms);
        const text = `exec ${r.timedOut ? "TIMED OUT" : "exit " + r.code} (${r.ms}ms):\n` + r.head;
        await index("step", refOf(`exec ${a.label || a.cmd}`), `${a.cmd}\n${text}`);
        return { text, outputHash: r.outputHash, failed: r.timedOut || r.code !== 0 };
      }
      case "read": {
        if (!a.path) return fail("read needs path");
        let content: string;
        try {
          const buf = readFileSync(a.path);
          content = buf.length > READ_CAP
            ? buf.slice(0, READ_CAP / 2).toString("utf8") + `\n…(${buf.length} bytes, truncated)…\n` + buf.slice(-READ_CAP / 2).toString("utf8")
            : buf.toString("utf8");
        } catch (e: any) {
          return fail(`read ${a.path}: ${e.message}`);
        }
        const off = a.offset ?? 0, lim = Math.min(a.limit ?? 60, 200);
        const lines = content.split("\n").slice(off, off + lim).join("\n");
        recordStep(db, job.id, "read", { path: a.path, offset: off, limit: lim }, fingerprint(a),
          "done", lines.slice(0, 4000), hashText(lines), null, 0);
        const text = `read ${a.path} (lines ${off}-${off + lim}):\n` + lines;
        await index("step", refOf(`read ${a.path}`), text);
        return { text, outputHash: hashText(lines), failed: false };
      }
      case "write": {
        if (!a.path || a.content === undefined) return fail("write needs path and content");
        if (Buffer.byteLength(a.content, "utf8") > WRITE_CAP) return fail(`write exceeds ${WRITE_CAP} byte cap`);
        mkdirSync(dirname(a.path), { recursive: true });
        writeFileSync(a.path, a.content);
        recordStep(db, job.id, "write", { path: a.path, bytes: a.content.length }, fingerprint(a),
          "done", `wrote ${a.content.length} bytes to ${a.path}`, hashText(a.content), null, 0);
        await index("step", refOf(`write ${a.path}`), `wrote ${a.path}:\n${a.content.slice(0, 4000)}`);
        return { text: `wrote ${a.content.length} bytes to ${a.path}`, outputHash: hashText(a.content), failed: false };
      }
      case "note": {
        addLedger(db, job.id, "note", a.text || "");
        await index("note", refOf(a.text || "note"), a.text || "");
        return { text: "noted", outputHash: hashText("note:" + (a.text || "")), failed: false };
      }
      case "recall": {
        const q = (a.query || "").trim();
        if (!q) return fail("recall needs query");
        const k = Math.min(Math.max(a.k ?? 3, 1), 5);
        const hits = await recall(db, job.id, q, k, embedder);
        const text = hits.length
          ? "recall results:\n\n" + hits.map((h) =>
              `[${h.kind} ${h.ref} score=${h.score.toFixed(2)}]\n${h.text.slice(0, 1500)}`).join("\n\n")
          : "recall: no indexed memory yet for this query";
        recordStep(db, job.id, "recall", { query: q, k }, fingerprint(a),
          "done", text.slice(0, 4000), hashText(text), null, 0);
        // recall output is a copy of indexed chunks — not re-indexed
        return { text, outputHash: hashText(text), failed: false };
      }
      case "research": {
        const q = (a.question || "").trim().slice(0, 500);
        if (!q) return fail("research needs question");
        const lvBase = (process.env.LONGVIEW_URL || "http://127.0.0.1:3011").replace(/\/$/, "");
        const timeoutMs = Math.min((a.timeout_s ?? 600) * 1000, 1800_000);

        // Optional Beacon fan-out: "industry in location" → business entities
        // searched in parallel with the Longview web run.
        const business = (a.business || "").trim();
        let beaconSpec: { industry: string; location: string } | null = null;
        if (business) {
          const m = business.match(/^(.+?)\s+in\s+(.+)$/i);
          if (m) beaconSpec = { industry: m[1].trim().slice(0, 80), location: m[2].trim().slice(0, 80) };
        }
        const bcBase = (process.env.BEACON_URL || "http://127.0.0.1:3012").replace(/\/$/, "");

        /** Start the Longview run; resolves to run id or throws. */
        const startLongview = async (): Promise<number> => {
          const r = await fetch(lvBase + "/api/agent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ question: q }),
            signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) throw new Error(`http ${r.status}`);
          const j: any = await r.json();
          const id = Number(j.run_id);
          if (!Number.isFinite(id)) throw new Error("no run id");
          return id;
        };

        /** Start a Beacon business search; resolves to job id or null (fail-soft). */
        const startBeacon = async (): Promise<string | null> => {
          if (!beaconSpec) return null;
          try {
            const r = await fetch(bcBase + "/api/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(beaconSpec),
              signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) return null;
            const j: any = await r.json();
            return typeof j.job_id === "string" ? j.job_id : null;
          } catch { return null; }
        };

        let lvId: number;
        let bcId: string | null = null;
        try {
          [lvId, bcId] = await Promise.all([
            startLongview().catch((e: any) => { throw new Error(`longview: ${e.message}`); }),
            startBeacon(),
          ]);
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (msg.startsWith("longview:")) {
            // Beacon alone is still useful if Longview is down and vice versa —
            // but without Longview this isn't a research action; fail with guidance.
            return fail(`research: cannot reach longview at ${lvBase} — is it running?`);
          }
          return fail(`research: ${msg.slice(0, 200)}`);
        }
        // Poll until the run finishes. Longview is async; research takes minutes.
        // Beacon (if fanned out) is polled alongside.
        const t0 = Date.now();
        let run: any = null;
        let beacon: any = null;
        let beaconDone = !bcId;
        for (;;) {
          await new Promise((r) => setTimeout(r, 15000));
          if (Date.now() - t0 > timeoutMs) {
            return fail(`research: longview run ${lvId} still working after ${Math.round(timeoutMs / 60000)}min — check it at ${lvBase}`);
          }
          try {
            const r = await fetch(`${lvBase}/api/agent/${lvId}`, { signal: AbortSignal.timeout(15000) });
            if (r.ok) run = (await r.json()).run;
          } catch { /* keep polling */ }
          if (bcId && !beaconDone) {
            try {
              const r = await fetch(`${bcBase}/api/search/${encodeURIComponent(bcId)}`, { signal: AbortSignal.timeout(15000) });
              if (r.ok) {
                const j: any = await r.json();
                if (j.status === "done" || j.status === "error") { beacon = j; beaconDone = true; }
              }
            } catch { /* keep polling */ }
          }
          const lvDone = run && (run.status === "done" || run.status === "error");
          if (lvDone && beaconDone) break;
        }
        if (!run || run.status !== "done") {
          return fail(`research: longview run ${lvId} failed: ${String(run?.error || "unknown").slice(0, 200)}`);
        }
        // Compact findings for the bounded context: findings list first,
        // then a clipped report. Raw pages never enter the thinker's context.
        const findings: string[] = Array.isArray(run.findings) ? run.findings : [];
        const sources: string[] = Array.isArray(run.sources) ? run.sources : [];
        let text = "";
        if (findings.length) {
          text = "research findings:\n" + findings.slice(0, 12).map((f: any) =>
            `- ${typeof f === "string" ? f : JSON.stringify(f)}`.slice(0, 600)).join("\n");
        } else if (run.report_md) {
          text = "research report (clipped):\n" + String(run.report_md).slice(0, 3000);
        } else {
          text = "research: longview finished but returned no findings";
        }
        if (sources.length) {
          text += "\n\nsources: " + sources.slice(0, 8).join(", ").slice(0, 500);
        }
        // Beacon business entities, compact.
        if (beacon && beacon.status === "done") {
          const cos: any[] = Array.isArray(beacon.companies) ? beacon.companies : [];
          if (cos.length) {
            text += `\n\nbeacon: ${cos.length} ${beaconSpec!.industry} in ${beaconSpec!.location}:\n` +
              cos.slice(0, 10).map((c: any) => {
                const where = [c.city, c.state].filter(Boolean).join(", ");
                return `- ${c.name || "?"}` +
                  (where ? ` — ${where}` : "") +
                  (c.url ? ` (${c.url})` : "") +
                  (c.description ? `: ${String(c.description).slice(0, 100)}` : "");
              }).join("\n");
          } else {
            text += `\n\nbeacon: no ${beaconSpec!.industry} found in ${beaconSpec!.location}`;
          }
        } else if (bcId) {
          text += "\n\nbeacon: business search did not complete in time";
        }
        text = text.slice(0, 4000);
        recordStep(db, job.id, "research",
          { question: q, run_id: lvId, ...(beaconSpec ? { business: `${beaconSpec.industry} in ${beaconSpec.location}` } : {}) },
          fingerprint(a), "done", text, hashText(text), null, Date.now() - t0);
        await index("step", refOf(`research ${a.label || q}`), `${q}\n${text}`);
        return { text, outputHash: hashText(text), failed: false };
      }
      case "recon": {
        const base = (process.env.MERIDIAN_URL || "http://127.0.0.1:3005").replace(/\/$/, "");
        const jfetch = async (path: string, opts?: RequestInit): Promise<any> => {
          const r = await fetch(base + path, {
            ...opts,
            headers: { "content-type": "application/json", ...(opts?.headers || {}) },
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) throw new Error(`http ${r.status}`);
          return r.json();
        };

        // Pivot inside an existing investigation.
        if (a.investigation && a.transform) {
          const invId = a.investigation;
          let inv: any;
          try {
            inv = (await jfetch(`/api/investigations/${invId}`)).investigation;
          } catch {
            return fail(`recon: unknown investigation ${invId} (is meridian running at ${base}?)`);
          }
          const entities: any[] = inv.entities || [];
          const target = a.entity
            ? entities.find((e) => e.value === a.entity || e.id === a.entity)
            : entities[0];
          if (!target) return fail("recon: no entity to transform — pass \"entity\"");
          let out: any;
          try {
            out = await jfetch(`/api/investigations/${invId}/transform`, {
              method: "POST",
              body: JSON.stringify({ transformKey: a.transform, entityId: target.id }),
            });
          } catch (e: any) {
            return fail(`recon: transform failed — ${String(e?.message || e).slice(0, 200)}`);
          }
          const fresh: any[] = (out.investigation?.entities || []).filter((e: any) =>
            !entities.some((o: any) => o.id === e.id));
          let text = `recon: ran ${a.transform} on ${target.type}:${target.value}\n`;
          text += `note: ${String(out.note || "—").slice(0, 300)}\n`;
          text += `new entities (${out.addedEntities ?? fresh.length}):\n`;
          text += fresh.slice(0, 15).map((e: any) => `- [${e.type}] ${e.value}`).join("\n") || "(none new)";
          // Suggest next pivots from the new entities' types.
          text += `\n\ninvestigation: ${invId} — pass it back with another transform to keep pivoting.`;
          text = text.slice(0, 4000);
          recordStep(db, job.id, "recon",
            { investigation: invId, transform: a.transform, entity: target.value },
            fingerprint(a), "done", text, hashText(text), null, 0);
          await index("step", refOf(`recon ${a.transform} ${target.value}`), text);
          return { text, outputHash: hashText(text), failed: false };
        }

        // Start a new investigation from a seed target.
        const target = (a.target || "").trim().slice(0, 200);
        if (!target) {
          return fail('recon needs "target" (domain, ip, company, email...) or "investigation"+"transform" to pivot');
        }
        let inv: any;
        try {
          const created = await jfetch("/api/investigations", {
            method: "POST",
            body: JSON.stringify({
              name: (a.label || `recon: ${target}`).slice(0, 80),
              seedValue: target,
            }),
          });
          inv = created.investigation;
        } catch {
          return fail(`recon: cannot reach meridian at ${base} — is it running?`);
        }
        const entities: any[] = inv.entities || [];
        const seed = entities[0];
        // Fetch available transforms for the seed's type.
        let available: string[] = [];
        try {
          const ts: any = await jfetch("/api/transforms");
          available = (ts.transforms || [])
            .filter((t: any) => (t.inputTypes || []).includes(seed?.type))
            .map((t: any) => t.key);
        } catch { /* transforms list optional */ }
        let text = `recon: investigation ${inv.id} seeded with [${seed?.type}] ${seed?.value}\n`;
        text += available.length
          ? `available pivots: ${available.join(", ")}\nRun one with {"action":"recon","investigation":"${inv.id}","transform":"<key>","entity":"${seed?.value}"}`
          : "no transforms available for this entity type";
        text = text.slice(0, 2000);
        recordStep(db, job.id, "recon", { target, investigation: inv.id }, fingerprint(a),
          "done", text, hashText(text), null, 0);
        await index("step", refOf(`recon ${target}`), text);
        return { text, outputHash: hashText(text), failed: false };
      }
      default:
        return fail(`unknown action ${a.action}`);
    }
  } catch (e: any) {
    return fail(`harness error: ${e.message}`);
  }
}

/** Run one job to a terminal state. */
export async function runJob(db: Database, jobId: string, opts: WorkOpts = {}): Promise<void> {
  const job = db.query(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as Job | null;
  if (!job) throw new Error(`unknown job ${jobId}`);
  if (job.status !== "running" && job.status !== "pending") return;
  setStatus(db, job, "running");

  const thinker = job.thinker || opts.thinkerDefault || process.env.LOOM_THINKER;
  if (!thinker) {
    setStatus(db, job, "blocked", "no thinker configured (set LOOM_THINKER or job thinker)");
    outbox(db, job.id, "blocked", "no thinker configured");
    return;
  }

  const logDir = (process.env.LOOM_DATA_DIR || "data") + `/logs/${job.id}`;
  let spin = loadSpin(db, jobId);
  spin.strikes = job.spin_strikes || 0;
  const t0 = Date.now();
  let thinkFails = 0;
  let extraSystem: string | null = null;

  // vector memory: one embedder per job run; warn once if it fails
  const embedder = getEmbedder();
  const index = async (kind: string, ref: string, text: string): Promise<void> => {
    const ok = await indexChunk(db, job.id, kind, ref, text, embedder);
    if (!ok && !getKv(db, `loom:embed:warn:${job.id}`)) {
      setKv(db, `loom:embed:warn:${job.id}`, String(Date.now()));
      addLedger(db, job.id, "system", "vector indexing unavailable (embedder failed) — recall will be limited");
    }
  };

  addLedger(db, job.id, "system", `job started (max ${job.max_steps} steps, ${job.max_wall_s}s wall)`);
  await index("goal", "goal", job.goal);
  if (job.plan) await index("plan", "plan", job.plan);

  for (;;) {
    touch(db, job);
    const stepCount = (db.query(`SELECT COUNT(*) AS n FROM steps WHERE job_id = ?`).get(job.id) as { n: number }).n;
    if (stepCount >= job.max_steps) {
      setStatus(db, job, "failed", `step budget exhausted (${job.max_steps})`);
      outbox(db, job.id, "failed", "step budget exhausted");
      return;
    }
    if ((Date.now() - t0) / 1000 > job.max_wall_s) {
      setStatus(db, job, "failed", "wall-clock budget exhausted");
      outbox(db, job.id, "failed", "wall-clock budget exhausted");
      return;
    }

    let ctx = buildContext(db, job.id, job.goal, job.plan, null, extraSystem);
    extraSystem = null;

    // auto-augment: when the ledger tail truncated, pull the most relevant
    // older chunks back in from vector memory (bounded, stays under budget)
    if (ctx.includes("…(older history truncated)…") || ctx.includes("…(context truncated to budget)…")) {
      const latest = db.query(`SELECT text FROM ledger WHERE job_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(job.id) as { text: string } | null;
      const hits = await recall(db, job.id, (job.goal + "\n" + (latest?.text || "")).slice(0, 1000), 2, embedder);
      if (hits.length) {
        const budget = getContextBudget();
        const room = budget - Buffer.byteLength(ctx, "utf8");
        if (room > 300) {
          const mem = "# RELEVANT MEMORY (auto-recalled from earlier steps)\n" +
            hits.map((h) => `[${h.kind} ${h.ref}]\n${h.text}`).join("\n\n");
          const buf = Buffer.from(mem, "utf8").slice(0, room - 64);
          ctx += "\n\n" + buf.toString("utf8") + "\n…(memory clipped to budget)…";
        }
      }
    }

    const tr = await think(thinker, ctx, { timeout_s: thinkTimeout(300) });

    if (!tr.ok || !tr.action) {
      thinkFails++;
      addLedger(db, job.id, "system", `thinker failure (${thinkFails}): ${tr.error}`);
      if (thinkFails >= 3) {
        setStatus(db, job, "blocked", `thinker failed 3x: ${tr.error}`);
        outbox(db, job.id, "blocked", `thinker failed repeatedly: ${tr.error}`);
        return;
      }
      await Bun.sleep(2000);
      continue;
    }
    thinkFails = 0;
    const a = tr.action;
    const fp = fingerprint(a);

    // terminal actions
    if (a.action === "finish") {
      setStatus(db, job, "done", a.summary || "done");
      addLedger(db, job.id, "decision", "finished: " + (a.summary || ""));
      await index("summary", "finish", a.summary || "done");
      outbox(db, job.id, "done", a.summary || "job complete");
      return;
    }
    if (a.action === "blocked") {
      setStatus(db, job, "blocked", a.reason || "blocked");
      addLedger(db, job.id, "decision", "blocked: " + (a.reason || ""));
      await index("summary", "blocked", a.reason || "blocked");
      outbox(db, job.id, "blocked", a.reason || "blocked");
      return;
    }

    const r = await executeAction(db, job, a, logDir, embedder, index);
    addLedger(db, job.id, r.failed ? "observation" : "action",
      `${a.action}${a.label ? ` (${a.label})` : ""}: ${r.text.slice(0, 1500)}`);

    // spin check on the completed action
    const { state, verdict } = observe(spin, fp, r.outputHash);
    spin = state;
    db.query(`UPDATE jobs SET spin_strikes = ? WHERE id = ?`).run(spin.strikes, job.id);

    if (verdict.kind === "strike") {
      addLedger(db, job.id, "system", `spin warning (${verdict.strikes}/${MAX_STRIKES}): ${verdict.reason} — vary your approach`);
    } else if (verdict.kind === "spin") {
      const key = `loom:replan:${job.id}`;
      if (getKv(db, key)) {
        setStatus(db, job, "blocked", `spinning after replan prompt: ${verdict.reason}`);
        outbox(db, job.id, "blocked", `gave up: repeated the same action with identical output ${MAX_STRIKES}+ times even after a replan prompt`);
        return;
      }
      setKv(db, key, String(Date.now()));
      extraSystem = replanPrompt(fp, verdict.reason);
      addLedger(db, job.id, "system", "spin detected — replan prompt injected");
      spin.strikes = MAX_STRIKES - 1; // one last chance after the prompt
      db.query(`UPDATE jobs SET spin_strikes = ? WHERE id = ?`).run(spin.strikes, job.id);
    }
  }
}

/** Claim the next job (or reclaim a stale one) and run it. Returns false when idle. */
export async function workOnce(db: Database, opts: WorkOpts = {}): Promise<boolean> {
  const staleAt = Date.now() - STALE_HEARTBEAT_S * 1000;
  const job = db.query(
    `SELECT * FROM jobs WHERE status = 'pending'
     UNION ALL
     SELECT * FROM jobs WHERE status = 'running' AND heartbeat_at < ?
     ORDER BY created_at LIMIT 1`
  ).get(staleAt) as Job | null;
  if (!job) return false;
  if (job.status === "running") {
    addLedger(db, job.id, "system", "previous worker died (stale heartbeat) — resuming from persisted state");
  }
  await runJob(db, job.id, opts);
  return true;
}

/** Daemon loop. */
export async function work(db: Database, opts: WorkOpts = {}): Promise<void> {
  for (;;) {
    const busy = await workOnce(db, opts);
    if (busy && opts.once) return;
    if (!busy) {
      if (opts.once) return;
      await Bun.sleep(5000);
    }
  }
}

export function openDefaultDb(): Database {
  return openDb();
}
