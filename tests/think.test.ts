/* think.test.ts — thinkTimeout env knob. Run with bun. */
import { thinkTimeout } from "../src/think";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

const saved = process.env.LOOM_THINK_TIMEOUT_S;

delete process.env.LOOM_THINK_TIMEOUT_S;
ok(thinkTimeout() === 300, "default fallback is 300");
ok(thinkTimeout(120) === 120, "caller fallback honored when unset");

process.env.LOOM_THINK_TIMEOUT_S = "900";
ok(thinkTimeout() === 900, "env var overrides default");
ok(thinkTimeout(120) === 900, "env var overrides caller fallback too");

process.env.LOOM_THINK_TIMEOUT_S = "45.9";
ok(thinkTimeout() === 45, "fractional values floored");

for (const bad of ["0", "-5", "abc", "", "NaN", "Infinity"]) {
  process.env.LOOM_THINK_TIMEOUT_S = bad;
  ok(thinkTimeout(300) === 300, `invalid ${JSON.stringify(bad)} falls back`);
}

if (saved === undefined) delete process.env.LOOM_THINK_TIMEOUT_S;
else process.env.LOOM_THINK_TIMEOUT_S = saved;

console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
