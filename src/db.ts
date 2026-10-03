/* db.ts — SQLite persistence for loom. The durable thought lives here, not in RAM. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface Job {
  id: string;
  name: string;
  goal: string;
  plan: string | null;          // JSON array of seeded plan steps (advisory)
  status: "pending" | "running" | "done" | "failed" | "blocked";
  thinker: string | null;       // command override, else env LOOM_THINKER
  max_steps: number;
  max_wall_s: number;
  spin_strikes: number;
  created_at: number;
  updated_at: number;
  heartbeat_at: number;
  result: string | null;
}

export interface Step {
  id: number;
  job_id: string;
  seq: number;
  action: string;               // exec|read|write|note|finish|blocked
  args: string;                 // JSON
  fingerprint: string;
  status: "done" | "failed";
  output_head: string;          // capped
  output_hash: string;
  log_path: string | null;      // spilled full output
  ms: number;
  created_at: number;
}

export function openDb(path?: string): Database {
  const p = path || process.env.LOOM_DATA_DIR || join(import.meta.dir, "..", "data", "loom.db");
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      plan TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      thinker TEXT,
      max_steps INTEGER NOT NULL DEFAULT 200,
      max_wall_s INTEGER NOT NULL DEFAULT 21600,
      spin_strikes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      seq INTEGER NOT NULL,
      action TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '{}',
      fingerprint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      output_head TEXT NOT NULL DEFAULT '',
      output_hash TEXT NOT NULL DEFAULT '',
      log_path TEXT,
      ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id, seq);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_job ON ledger(job_id, seq);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  return db;
}

export function getKv(db: Database, k: string): string | null {
  const r = db.query(`SELECT v FROM kv WHERE k = ?`).get(k) as { v: string } | null;
  return r ? r.v : null;
}

export function setKv(db: Database, k: string, v: string): void {
  db.query(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
}

let seqCounters = new Map<string, number>();
/** Next per-job sequence number (in-process; single worker per job). */
export function nextSeq(db: Database, jobId: string): number {
  let n = seqCounters.get(jobId);
  if (n === undefined) {
    const r = db.query(`SELECT COALESCE(MAX(seq), -1) AS m FROM steps WHERE job_id = ?`).get(jobId) as { m: number };
    const r2 = db.query(`SELECT COALESCE(MAX(seq), -1) AS m FROM ledger WHERE job_id = ?`).get(jobId) as { m: number };
    n = Math.max(r.m, r2.m);
  }
  n += 1;
  seqCounters.set(jobId, n);
  return n;
}

export function addLedger(db: Database, jobId: string, kind: string, text: string): void {
  db.query(`INSERT INTO ledger (job_id, seq, kind, text, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(jobId, nextSeq(db, jobId), kind, text, Date.now());
}

export function recordStep(
  db: Database, jobId: string, action: string, args: unknown,
  fingerprint: string, status: "done" | "failed",
  outputHead: string, outputHash: string, logPath: string | null, ms: number,
): void {
  db.query(`INSERT INTO steps (job_id, seq, action, args, fingerprint, status, output_head, output_hash, log_path, ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(jobId, nextSeq(db, jobId), action, JSON.stringify(args), fingerprint, status, outputHead, outputHash, logPath, ms, Date.now());
}
