/* onboard.test.ts — Ollama onboarding state machine, driven with fakes. Run with bun. */
import { runOnboarding, type OnboardDeps } from "../src/chat/onboard";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

interface St {
  answers: string[]; said: string[];
  serverUp: boolean; upAfter: number; tags: string[];
  runs: string[][]; spawned: string[][]; pullCode: number;
}
function makeDeps(s: St, over: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    ask: async (q: string) => { s.said.push("ASK:" + q); return s.answers.shift() ?? ""; },
    say: (m: string) => { s.said.push(m); },
    httpGet: async (url: string) => {
      if (url.endsWith("/api/version")) {
        if (s.upAfter > 0) { s.upAfter--; return { ok: false, json: async () => ({}) }; }
        if (!s.serverUp) throw new Error("conn refused");
        return { ok: true, json: async () => ({ version: "0.0" }) };
      }
      if (url.endsWith("/api/tags"))
        return { ok: true, json: async () => ({ models: s.tags.map((name) => ({ name })) }) };
      throw new Error("unexpected url " + url);
    },
    run: async (cmd: string[]) => { s.runs.push(cmd); return { code: s.pullCode }; },
    spawnDetached: (cmd: string[]) => { s.spawned.push(cmd); },
    ollamaBin: "/usr/bin/ollama",
    baseUrl: "http://localhost:11434",
    modelName: "qwen3.5:2b",
    modelFile: "/m/qwen3.5-2b-tool.json",
    thinkerScript: "/e/thinker-model.sh",
    serveLogFile: "/tmp/ollama-serve.log",
    pollTries: 4, pollMs: 5,
    ...over,
  };
}
const fresh = (): St => ({ answers: [], said: [], serverUp: true, upAfter: 0, tags: ["qwen3.5:2b"], runs: [], spawned: [], pullCode: 0 });

// 1. happy path: everything ready, no questions asked
{
  const s = fresh();
  const r = await runOnboarding(makeDeps(s));
  ok(!!r, "happy path returns a result");
  ok(r!.thinker === "sh /e/thinker-model.sh", "thinker points at thinker-model.sh");
  ok(r!.env.LOOM_MODEL_FILE === "/m/qwen3.5-2b-tool.json", "env sets LOOM_MODEL_FILE");
  ok(r!.env.LOOM_CONTEXT_BUDGET === "12288", "env sets LOOM_CONTEXT_BUDGET");
  ok(!s.said.some((m) => m.startsWith("ASK:")), "no prompts when everything is ready");
  ok(r!.exportHint.includes("LOOM_THINKER") && r!.exportHint.includes("LOOM_MODEL_FILE"), "export hint covers all three vars");
  ok(s.spawned.length === 0 && s.runs.length === 0, "no side effects on happy path");
}

// 1b. :latest tag variant counts as present
{
  const s = fresh(); s.tags = ["qwen3.5:2b:latest"];
  const r = await runOnboarding(makeDeps(s));
  ok(!!r && s.runs.length === 0, "qwen3.5:2b:latest tag counts as pulled");
}

// 2. server down, user says yes -> serve started, server comes up
{
  const s = fresh(); s.serverUp = true; s.upAfter = 3; s.answers = ["y"];
  const r = await runOnboarding(makeDeps(s));
  ok(!!r, "server started on yes returns result");
  ok(s.spawned.length === 1 && s.spawned[0].join(" ") === "/usr/bin/ollama serve", "ollama serve spawned detached");
}

// 2b. "YES" counts as yes
{
  const s = fresh(); s.serverUp = true; s.upAfter = 1; s.answers = ["YES"];
  const r = await runOnboarding(makeDeps(s));
  ok(!!r && s.spawned.length === 1, "YES accepted at the serve prompt");
}

// 3. server down, user says no -> null, nothing started
{
  const s = fresh(); s.serverUp = false; s.answers = ["n"];
  const r = await runOnboarding(makeDeps(s));
  ok(r === null, "declining serve returns null");
  ok(s.spawned.length === 0, "nothing spawned on decline");
}

// 4. server never comes up -> null
{
  const s = fresh(); s.serverUp = false; s.upAfter = 999; s.answers = ["y"];
  const r = await runOnboarding(makeDeps(s));
  ok(r === null, "unresponsive server after start returns null");
  ok(s.said.some((m) => m.includes("ollama serve")), "told how to start manually");
}

// 5. model missing, user pulls -> pull runs, result returned
{
  const s = fresh(); s.tags = []; s.answers = ["y"];
  const r = await runOnboarding(makeDeps(s));
  ok(!!r, "pulling the model returns a result");
  ok(s.runs.length === 1 && s.runs[0].join(" ") === "/usr/bin/ollama pull qwen3.5:2b", "ollama pull invoked with the model");
}

// 6. model missing, user declines -> null, no pull
{
  const s = fresh(); s.tags = []; s.answers = [""];
  const r = await runOnboarding(makeDeps(s));
  ok(r === null, "declining pull returns null");
  ok(s.runs.length === 0, "no pull on empty answer");
  ok(s.said.some((m) => m.includes("ollama pull qwen3.5:2b")), "told the manual pull command");
}

// 7. pull fails -> null
{
  const s = fresh(); s.tags = []; s.answers = ["y"]; s.pullCode = 1;
  const r = await runOnboarding(makeDeps(s));
  ok(r === null, "failed pull returns null");
}

// 8. ollama not installed -> null with install pointer
{
  const s = fresh();
  const r = await runOnboarding(makeDeps(s, { ollamaBin: null }));
  ok(r === null, "missing binary returns null");
  ok(s.said.some((m) => m.includes("ollama.com")), "points at ollama.com install");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
