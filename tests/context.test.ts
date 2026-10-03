/* context.test.ts — hard budget enforcement. Run with bun. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, addLedger } from "../src/db";
import { buildContext, CONTEXT_BUDGET } from "../src/context";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "loom-ctx-"));
const db = openDb(join(tmp, "t.db"));
const J = "job_1";
db.query(`INSERT INTO jobs (id, name, goal, status, created_at, updated_at, heartbeat_at) VALUES (?,?,?,?,?,?,?)`)
  .run(J, "t", "g".repeat(10000), "pending", 1, 1, 1);

// flood the ledger with huge entries
for (let i = 0; i < 80; i++) addLedger(db, J, "action", "entry " + i + " " + "x".repeat(2000));

const ctx = buildContext(db, J, "g".repeat(10000), "plan".repeat(5000), "r".repeat(20000), "sys".repeat(5000));
ok(Buffer.byteLength(ctx, "utf8") <= CONTEXT_BUDGET, `context <= ${CONTEXT_BUDGET} bytes (got ${Buffer.byteLength(ctx, "utf8")})`);
ok(ctx.includes("# GOAL") && ctx.includes("# HISTORY") && ctx.includes("# YOUR MOVE"), "sections present");
ok(ctx.includes("truncated"), "truncation marked");

const empty = buildContext(db, "nope", "short goal", null, null, null);
ok(empty.includes("short goal"), "small context passes through");

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
