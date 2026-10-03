#!/usr/bin/env bun
/* loom — a harness for long thoughts in low-memory environments. */
import { openDb, addLedger } from "./db";
import { work } from "./loop";
import { rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const db = openDb();
const [, , cmd, ...rest] = process.argv;

function usage(): void {
  console.log(`loom — long thoughts, low memory. Jobs persist in SQLite; workers are ephemeral.

  loom submit "<goal>" [--name N] [--plan-file F] [--max-steps N] [--thinker CMD]
  loom work [--once]            run the daemon (claims jobs, resumes stale ones)
  loom chat                     Pi-style minimal TUI chat with the thinker
  loom board                    all jobs at a glance
  loom status <id>              job detail
  loom log <id> [--tail N]      the thought, oldest→newest
  loom wait <id>                 block until the job finishes
  loom cancel <id>              stop a job
  loom outbox                   undelivered completion notices
  loom gc [--days N]            delete old logs, vacuum (default 14d)

The thinker is any command reading the context JSON on stdin and printing one
JSON action on stdout. Set LOOM_THINKER (or --thinker). See examples/.`);
}

function arg(flag: string): string | null {
  const i = rest.indexOf(flag);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : null;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "submit": {
      const goal = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
      if (!goal) { console.error("usage: loom submit \"<goal>\" [flags]"); process.exit(1); }
      const id = "job_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
      const planFile = arg("--plan-file");
      const plan = planFile ? await Bun.file(planFile).text() : null;
      const now = Date.now();
      db.query(`INSERT INTO jobs (id, name, goal, plan, status, thinker, max_steps, max_wall_s, created_at, updated_at, heartbeat_at)
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .run(id, arg("--name") || goal.slice(0, 60), goal, plan,
          arg("--thinker"), Number(arg("--max-steps") || 200), 21600, now, now, now);
      addLedger(db, id, "system", "job submitted");
      console.log(id);
      break;
    }
    case "work": {
      await work(db, { once: rest.includes("--once") });
      break;
    }
    case "chat": {
      if (!process.stdin.isTTY) { console.error("loom chat needs a terminal"); process.exit(1); }
      let thinker = process.env.LOOM_THINKER;
      if (!thinker) {
        // first run: walk through local Ollama setup instead of dying
        const { runOnboarding, realDeps } = await import("./chat/onboard");
        const { join } = await import("node:path");
        const deps = realDeps(join(import.meta.dir, ".."));
        const res = await runOnboarding(deps);
        deps.close();
        if (!res) process.exit(1);
        thinker = res.thinker;
        Object.assign(process.env, res.env);
        console.log(`\n${res.exportHint}\n`);
      }
      const { ChatSession, defaultCommandsDir, defaultTranscriptPath } = await import("./chat/session");
      const { Tui } = await import("./chat/tui");
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const session = new ChatSession(db, thinker, defaultCommandsDir());
      await session.init();
      mkdirSync(dirname(defaultCommandsDir()), { recursive: true });
      const tui = new Tui(session);
      await tui.run();
      // auto-save the transcript (the ledger already has it; this is the readable copy)
      const p = defaultTranscriptPath(session.jobId);
      mkdirSync(dirname(p), { recursive: true });
      await Bun.write(p, session.transcript());
      console.log(`\ntranscript saved to ${p}  (replay with: loom log ${session.jobId})`);
      break;
    }
    case "board": {
      const rows = db.query(`SELECT id, name, status, spin_strikes,
        (SELECT COUNT(*) FROM steps WHERE job_id = jobs.id) AS steps,
        result FROM jobs ORDER BY created_at DESC LIMIT 30`).all() as any[];
      if (!rows.length) { console.log("no jobs yet — loom submit \"<goal>\""); break; }
      console.log("id".padEnd(20) + "status".padEnd(10) + "steps".padEnd(8) + "spin".padEnd(6) + "name");
      for (const r of rows) {
        console.log(String(r.id).padEnd(20) + String(r.status).padEnd(10) + String(r.steps).padEnd(8) + String(r.spin_strikes).padEnd(6) + r.name);
      }
      break;
    }
    case "status": {
      const id = rest[0];
      const j = db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
      if (!j) { console.error("unknown job"); process.exit(1); }
      const n = (db.query(`SELECT COUNT(*) AS n FROM steps WHERE job_id = ?`).get(id) as any).n;
      const { vectorCount } = await import("./vector");
      console.log(`${j.id} — ${j.name}\nstatus: ${j.status}  steps: ${n}/${j.max_steps}  spin strikes: ${j.spin_strikes}  vectors: ${vectorCount(db, id)}\nresult: ${j.result || "—"}`);
      break;
    }
    case "recall": {
      const id = rest[0];
      const k = Math.min(Math.max(Number(arg("--k") || 3), 1), 8);
      const q = rest.slice(1).filter((x) => !x.startsWith("--")).join(" ");
      if (!id || !q) { console.error("usage: loom recall <job-id> <query...> [--k N]"); process.exit(1); }
      const { recall, getEmbedder } = await import("./vector");
      const hits = await recall(db, id, q, k, getEmbedder());
      if (!hits.length) { console.log("(no indexed memory for this job)"); break; }
      for (const h of hits) console.log(`[${h.kind} ${h.ref} score=${h.score.toFixed(3)}]\n${h.text.slice(0, 1200)}\n`);
      break;
    }
    case "log": {
      const id = rest[0];
      const tail = Number(arg("--tail") || 40);
      const rows = db.query(`SELECT seq, kind, text FROM ledger WHERE job_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(id, tail) as any[];
      for (const r of rows.reverse()) {
        console.log(`#${r.seq} [${r.kind}] ${String(r.text).slice(0, 500)}`);
      }
      break;
    }
    case "wait": {
      const id = rest[0];
      for (;;) {
        const j = db.query(`SELECT status, result FROM jobs WHERE id = ?`).get(id) as any;
        if (!j) { console.error("unknown job"); process.exit(1); }
        if (["done", "failed", "blocked"].includes(j.status)) {
          console.log(`${j.status}: ${j.result || ""}`);
          process.exit(j.status === "done" ? 0 : 1);
        }
        await Bun.sleep(3000);
      }
    }
    case "cancel": {
      db.query(`UPDATE jobs SET status = 'blocked', result = 'cancelled by user', updated_at = ? WHERE id = ?`).run(Date.now(), rest[0]);
      console.log("cancelled");
      break;
    }
    case "outbox": {
      const rows = db.query(`SELECT id, job_id, kind, text, created_at FROM outbox WHERE delivered = 0 ORDER BY id`).all() as any[];
      for (const r of rows) {
        console.log(`[${new Date(r.created_at).toLocaleString()}] ${r.job_id} ${r.kind}: ${String(r.text).slice(0, 300)}`);
      }
      db.query(`UPDATE outbox SET delivered = 1 WHERE delivered = 0`).run();
      if (!rows.length) console.log("(empty)");
      break;
    }
    case "gc": {
      const days = Number(arg("--days") || 14);
      const cutoff = Date.now() - days * 86400 * 1000;
      const dataDir = process.env.LOOM_DATA_DIR || join(import.meta.dir, "..", "data");
      let n = 0;
      try {
        for (const d of readdirSync(join(dataDir, "logs"))) {
          const p = join(dataDir, "logs", d);
          try {
            if (statSync(p).mtimeMs < cutoff) { rmSync(p, { recursive: true }); n++; }
          } catch {}
        }
      } catch {}
      db.query(`DELETE FROM outbox WHERE delivered = 1 AND created_at < ?`).run(cutoff);
      db.exec("VACUUM;");
      console.log(`gc: removed ${n} old log dirs, vacuumed`);
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => { console.error("loom:", e.message); process.exit(1); });
