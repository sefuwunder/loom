/* spin.test.ts — the anti-loop core. Run with bun. */
import { fingerprint, observe, emptySpin, MAX_STRIKES, replanPrompt } from "../src/spin";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

// fingerprint: whitespace-insensitive, key-order-insensitive, ignores timeout_s
const a1 = { action: "exec", cmd: "ls  -la", timeout_s: 120 };
const a2 = { action: "exec", cmd: "ls -la", timeout_s: 30 };
const a3 = { action: "exec", cmd: "ls -lb" };
ok(fingerprint(a1) === fingerprint(a2), "fingerprint ignores whitespace + timeout_s");
ok(fingerprint(a1) !== fingerprint(a3), "fingerprint distinguishes commands");
ok(fingerprint({ action: "read", path: "/x", b: 1, a: 2 } as any) === fingerprint({ action: "read", path: "/x", a: 2, b: 1 } as any), "key order ignored");

// identical repeats accumulate strikes
let s = emptySpin();
let r = observe(s, "fp1", "hashA"); s = r.state;
ok(r.verdict.kind === "ok", "first action ok");
r = observe(s, "fp1", "hashA"); s = r.state;
ok(r.verdict.kind === "strike" && (r.verdict as any).strikes === 1, "identical repeat = strike 1");
r = observe(s, "fp1", "hashA"); s = r.state;
ok(r.verdict.kind === "strike" && (r.verdict as any).strikes === 2, "identical repeat = strike 2");
r = observe(s, "fp1", "hashA"); s = r.state;
ok(r.verdict.kind === "spin", `spin at strike ${MAX_STRIKES}`);

// same action, different output = learning, not spinning
s = emptySpin();
r = observe(s, "fp1", "hashA"); s = r.state;
r = observe(s, "fp1", "hashB"); s = r.state;
ok(r.verdict.kind === "ok" && s.strikes === 0, "same action with new output is ok");

// new action resets the repeat counter
s = emptySpin();
r = observe(s, "fp1", "h"); s = r.state;
r = observe(s, "fp1", "h"); s = r.state; // strike 1
r = observe(s, "fp2", "h"); s = r.state;
ok(r.verdict.kind === "ok" && s.repeatCount === 0, "new action resets repeat");

ok(replanPrompt("fp1", "x").includes("spinning"), "replan prompt names the problem");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
