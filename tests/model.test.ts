/* model.test.ts — qwen3.5:2b tool model file + thinker-model.sh. Run with bun. */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { buildContext, getContextBudget } from "../src/context";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

const ROOT = new URL("..", import.meta.url).pathname;
const MODEL_FILE = join(ROOT, "models", "qwen3.5-2b-tool.json");
const THINKER = join(ROOT, "examples", "thinker-model.sh");

// ---- 1. model file shape ----
const mf = JSON.parse(readFileSync(MODEL_FILE, "utf8"));
ok(mf.model === "qwen3.5:2b", "model name is qwen3.5:2b");
ok(mf.api === "ollama" && typeof mf.base_url === "string", "api=ollama with base_url");
ok(mf.format === "json", "format json requested (Ollama JSON mode)");
ok(mf.disable_thinking === true, "thinking disabled for JSON-mode reliability");
const o = mf.options;
ok(o.temperature === 0.1 && o.temperature >= 0 && o.temperature <= 2, "temperature 0.1 (deterministic tool calls)");
ok(o.num_ctx === 8192, "num_ctx 8192 (fits <4GB with 2.7GB Q8_0 weights)");
ok(o.num_predict === 512 && o.num_predict <= 1024, "num_predict 512 (actions are short)");
ok(o.repeat_penalty > 1, "repeat_penalty set (anti-loop)");
ok(Number.isInteger(mf.context_budget) && mf.context_budget <= 16384, "context_budget <= default 16KB");
ok(Number.isInteger(mf.think_timeout_s) && mf.think_timeout_s > 0, "think_timeout_s set");
const sys = String(mf.system_prompt);
for (const a of ["exec", "read", "write", "note", "recall", "finish", "blocked"])
  ok(sys.includes(`"action":"${a}"`), `system prompt documents action ${a}`);
ok(sys.includes("EXACTLY ONE JSON"), "system prompt demands single JSON object");
ok(sys.includes("NEVER repeat"), "system prompt has anti-repeat rule");
ok(sys.length < 4000, `system prompt compact (${sys.length} chars, 2B-friendly)`);

// ---- 2. thinker-model.sh against stub servers ----
const tmp = mkdtempSync(join(tmpdir(), "loom-model-"));
const canned = '{"action":"note","text":"stubbed"}';

async function runThinker(env: Record<string, string>, stdinText: string): Promise<string> {
  const proc = Bun.spawn(["sh", THINKER], {
    env: { ...process.env, ...env },
    stdin: new Response(stdinText).body as ReadableStream,
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`thinker exited ${code}: ${err.slice(0, 300)}`);
  return out;
}

// stub Ollama native /api/chat
let seenNative: any = null;
const nativeSrv = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/api/chat") return new Response("nf", { status: 404 });
    seenNative = await req.json();
    return Response.json({ message: { role: "assistant", content: canned } });
  },
});
const nativePort = nativeSrv.port;

const nativeModel = join(tmp, "native.json");
writeFileSync(nativeModel, JSON.stringify({ ...mf, base_url: `http://127.0.0.1:${nativePort}` }));
const out1 = await runThinker({ LOOM_MODEL_FILE: nativeModel }, "CTX-HELLO");
ok(out1 === canned, "ollama path: stdout is the model content");
ok(seenNative?.model === "qwen3.5:2b", "ollama path: model name sent");
ok(seenNative?.format === "json", "ollama path: format json sent");
ok(seenNative?.think === false, "ollama path: think:false sent");
ok(seenNative?.stream === false, "ollama path: stream:false sent");
ok(seenNative?.options?.num_ctx === 8192 && seenNative?.options?.temperature === 0.1, "ollama path: options passed through");
ok(seenNative?.messages?.[0]?.role === "system" && seenNative?.messages?.[1]?.content === "CTX-HELLO", "ollama path: system + context messages");
nativeSrv.stop();

// stub OpenAI-compatible /v1/chat/completions
let seenOai: any = null;
const oaiSrv = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
    seenOai = await req.json();
    return Response.json({ choices: [{ message: { role: "assistant", content: canned } }] });
  },
});
const oaiPort = oaiSrv.port;
const oaiModel = join(tmp, "oai.json");
writeFileSync(oaiModel, JSON.stringify({ ...mf, api: "openai-chat", base_url: `http://127.0.0.1:${oaiPort}/v1` }));
const out2 = await runThinker({ LOOM_MODEL_FILE: oaiModel }, "CTX2");
ok(out2 === canned, "openai-chat path: stdout is the model content");
ok(seenOai?.model === "qwen3.5:2b", "openai-chat path: model name sent");
ok(seenOai?.temperature === 0.1 && seenOai?.max_tokens === 512, "openai-chat path: temperature/max_tokens mapped");
ok(!("options" in (seenOai ?? {})), "openai-chat path: no ollama-only options leaked");
oaiSrv.stop();

// env overrides
let seenOverride: any = null;
const ovSrv = Bun.serve({
  port: 0,
  async fetch(req) {
    seenOverride = await req.json();
    return Response.json({ message: { role: "assistant", content: canned } });
  },
});
const ovPort = ovSrv.port;
const ovModel = join(tmp, "ov.json");
writeFileSync(ovModel, JSON.stringify({ ...mf, base_url: "http://127.0.0.1:1", model: "should-be-overridden" }));
await runThinker({ LOOM_MODEL_FILE: ovModel, LOOM_MODEL: "qwen3.5:2b", LOOM_API_URL: `http://127.0.0.1:${ovPort}` }, "x");
ok(seenOverride?.model === "qwen3.5:2b", "LOOM_MODEL overrides model file");
ovSrv.stop();

// missing model file -> nonzero exit
{
  const proc = Bun.spawn(["sh", THINKER], {
    env: { ...process.env, LOOM_MODEL_FILE: join(tmp, "nope.json") },
    stdin: new Response("x").body as ReadableStream, stdout: "pipe", stderr: "pipe",
  });
  const code = await proc.exited;
  ok(code !== 0, "missing model file exits nonzero");
}

// ---- 3. LOOM_CONTEXT_BUDGET override ----
const db = openDb(join(tmp, "t.db"));
db.query(`INSERT INTO jobs (id, name, goal, status, created_at, updated_at, heartbeat_at) VALUES (?,?,?,?,?,?,?)`)
  .run("j1", "t", "g", "pending", 1, 1, 1);
const prev = process.env.LOOM_CONTEXT_BUDGET;
process.env.LOOM_CONTEXT_BUDGET = "4096";
ok(getContextBudget() === 4096, "getContextBudget reads env");
const small = buildContext(db, "j1", "g".repeat(10000), "p".repeat(5000), "r".repeat(20000), "s".repeat(5000));
ok(Buffer.byteLength(small, "utf8") <= 4096, `buildContext honors 4096 budget (got ${Buffer.byteLength(small, "utf8")})`);
ok(small.includes("# YOUR MOVE"), "protocol survives small budget");
process.env.LOOM_CONTEXT_BUDGET = "junk";
ok(getContextBudget() === 16384, "invalid budget falls back to 16384");
if (prev === undefined) delete process.env.LOOM_CONTEXT_BUDGET; else process.env.LOOM_CONTEXT_BUDGET = prev;

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
