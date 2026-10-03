/* loop.test.ts — the full react loop with a fake thinker. Run with bun. */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { workOnce } from "../src/loop";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "loom-loop-"));
process.env.LOOM_DATA_DIR = join(tmp, "data");
const db = openDb(join(tmp, "t.db"));
const THINKER = `sh ${join(import.meta.dir, "..", "examples", "thinker-fake.sh")}`;

async function submit(name: string, mode: string, maxSteps = 200): Promise<string> {
  const id = `job_${name}_${Date.now()}`;
  const stateFile = join(tmp, `state-${name}`);
  try { await Bun.write(stateFile, "0"); } catch {}
  const now = Date.now();
  db.query(`INSERT INTO jobs (id, name, goal, status, thinker, max_steps, max_wall_s, created_at, updated_at, heartbeat_at)
            VALUES (?, ?, ?, 'pending', ?, ?, 600, ?, ?, ?)`)
    .run(id, name, `fake goal ${name}`, `${THINKER}`, maxSteps, now, now, now);
  process.env[`FAKE_MODE_${name}`] = mode;
  return id;
}

// run the fake thinker with per-job mode via a wrapper
const origThinker = THINKER;

async function workJob(name: string, mode: string, maxSteps = 200): Promise<any> {
  const id = await submit(name, mode, maxSteps);
  // point the fake at this job's mode through the state file + a wrapper script
  const wrapper = join(tmp, `thinker-${name}.sh`);
  await Bun.write(wrapper,
    `#!/bin/sh\nexport FAKE_MODE=${mode}\nexport FAKE_STATE_FILE=${join(tmp, `state-${name}`)}\nexec sh ${join(import.meta.dir, "..", "examples", "thinker-fake.sh")}\n`);
  await Bun.$`chmod +x ${wrapper}`.quiet();
  db.query(`UPDATE jobs SET thinker = ? WHERE id = ?`).run(`sh ${wrapper}`, id);
  await workOnce(db, {});
  return db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
}

// 1. happy path: notes then finish
{
  const j = await workJob("happy", "finish-after-2");
  ok(j.status === "done", "fake job completes");
  ok((j.result || "").includes("fake job complete"), "result recorded");
  const n = (db.query(`SELECT COUNT(*) AS n FROM ledger WHERE job_id = ?`).get(j.id) as any).n;
  ok(n >= 3, `ledger has entries (${n})`);
  const ob = (db.query(`SELECT COUNT(*) AS n FROM outbox WHERE job_id = ?`).get(j.id) as any).n;
  ok(ob === 1, "completion notice in outbox");
}

// 2. spin: identical exec forever -> circuit breaker -> blocked (not infinite)
{
  const t0 = Date.now();
  const j = await workJob("spin", "spin", 60);
  const dt = Date.now() - t0;
  ok(j.status === "blocked", `spinner blocked, not looping (status=${j.status})`);
  ok((j.result || "").includes("spin"), `blocked reason names spinning: ${j.result}`);
  const n = (db.query(`SELECT COUNT(*) AS n FROM steps WHERE job_id = ?`).get(j.id) as any).n;
  ok(n <= 8, `gave up after ${n} steps, not 60`);
  ok(dt < 120000, `finished quickly (${Math.round(dt / 1000)}s)`);
}

// 3. stale heartbeat reclaim: crashed worker's job resumes
{
  const id = await submit("stale", "finish-after-1");
  db.query(`UPDATE jobs SET status = 'running', heartbeat_at = ? WHERE id = ?`).run(Date.now() - 600000, id);
  const wrapper = join(tmp, `thinker-stale.sh`);
  await Bun.write(wrapper,
    `#!/bin/sh\nexport FAKE_MODE=finish-after-1\nexport FAKE_STATE_FILE=${join(tmp, `state-stale`)}\nexec sh ${join(import.meta.dir, "..", "examples", "thinker-fake.sh")}\n`);
  await Bun.$`chmod +x ${wrapper}`.quiet();
  db.query(`UPDATE jobs SET thinker = ? WHERE id = ?`).run(`sh ${wrapper}`, id);
  const busy = await workOnce(db, {});
  const j = db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
  ok(busy && j.status === "done", "stale job reclaimed and completed");
  const sys = db.query(`SELECT text FROM ledger WHERE job_id = ? AND kind = 'system'`).all(id) as any[];
  ok(sys.some((r: any) => r.text.includes("resuming")), "resume noted in ledger");
}

// 4. memory: 12 steps x 2MB output — RSS stays bounded, DB stays small
{
  const j = await workJob("big", "bigexec-12");
  ok(j.status === "done", "big-output job completes");
  const rssMB = process.memoryUsage().rss / 1048576;
  ok(rssMB < 400, `RSS bounded at ${Math.round(rssMB)}MB despite 24MB of step output`);
  const dbMB = statSync(join(tmp, "t.db")).size / 1048576;
  ok(dbMB < 8, `DB stays small (${dbMB.toFixed(1)}MB) — output spilled to files`);
  const heads = db.query(`SELECT LENGTH(output_head) AS l FROM steps WHERE job_id = ?`).all(j.id) as any[];
  ok(heads.every((r: any) => r.l <= 40000), "every step head capped");
}

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
