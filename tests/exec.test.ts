/* exec.test.ts — timeouts, caps, spillover. Run with bun. */
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExec, HEAD_KEEP, TAIL_KEEP } from "../src/exec";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "loom-exec-"));
const logDir = join(tmp, "logs");

// basic success
{
  const r = await runExec("echo hello", { logDir });
  ok(r.code === 0 && !r.timedOut && r.head.includes("hello"), "echo works");
  ok(r.outputHash.length === 16, "output hashed");
}

// timeout kills the process
{
  const t0 = Date.now();
  const r = await runExec("sleep 30", { timeout_s: 1, logDir });
  const dt = Date.now() - t0;
  ok(r.timedOut && dt < 5000, `sleep killed on timeout (${dt}ms)`);
}

// huge output: capped in head, full log spilled, hash covers everything
{
  const r = await runExec("seq 1 200000", { logDir });
  ok(r.truncated, "large output flagged truncated");
  ok(Buffer.byteLength(r.head, "utf8") <= HEAD_KEEP + TAIL_KEEP + 512, `head capped (${Buffer.byteLength(r.head, "utf8")} bytes)`);
  ok(r.head.includes("1\n") && r.head.includes("200000"), "head has start and tail");
  const sz = statSync(r.logPath!).size;
  ok(sz > 1000000, `full output spilled to disk (${sz} bytes)`);
  const r2 = await runExec("seq 1 200000", { logDir });
  ok(r.outputHash === r2.outputHash, "identical output => identical hash (spin detection)");
  const r3 = await runExec("seq 1 200001", { logDir });
  ok(r.outputHash !== r3.outputHash, "different output => different hash");
}

// stderr merged
{
  const r = await runExec("echo oops >&2", { logDir });
  ok(r.head.includes("oops"), "stderr captured");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
