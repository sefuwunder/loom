/* loop.ts — the react loop. One durable thought, executed in bounded turns.
   Every turn: build bounded context -> think (ephemeral worker) -> execute one
   action -> ledger -> spin-check. Nothing accumulates in RAM. */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb, addLedger, recordStep, getKv, setKv, type Job } from "./db";
import { buildContext, getContextBudget } from "./context";
import { fingerprint, observe, emptySpin, replanPrompt, MAX_STRIKES, type SpinState } from "./spin";
import { think, hashText, type ThinkAction } from "./think";
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
async function executeAction(
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

    const tr = await think(thinker, ctx, { timeout_s: 300 });

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
