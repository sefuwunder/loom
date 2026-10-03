import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/* onboard.ts — first-run Ollama onboarding for `loom chat`.
   Runs only when LOOM_THINKER is unset. Walks the user through three checks:
   ollama installed? server responding? model pulled? Every side effect
   (starting the server, pulling the model) needs an explicit yes at a [y/N]
   prompt — nothing downloads or starts on its own.
   Returns the thinker command + env for this session, or null if the user
   bails or a step fails. All I/O is injected so tests can drive it with fakes. */

export interface OnboardDeps {
  ask: (q: string) => Promise<string>; // line prompt -> raw answer
  say: (s: string) => void;            // informational line
  httpGet: (url: string) => Promise<{ ok: boolean; json: () => Promise<any> }>;
  run: (cmd: string[], opts?: { inherit?: boolean }) => Promise<{ code: number }>;
  spawnDetached: (cmd: string[], logFile: string) => void;
  ollamaBin: string | null;   // resolved path, or null when not installed
  baseUrl: string;             // e.g. http://localhost:11434
  modelName: string;           // e.g. qwen3.5:2b
  modelFile: string;           // abs path to the model file
  thinkerScript: string;       // abs path to examples/thinker-model.sh
  serveLogFile: string;       // where `ollama serve` output goes
  pollTries?: number;          // server-start poll attempts (default 30)
  pollMs?: number;             // ms between polls (default 500)
}

export interface OnboardResult {
  thinker: string;
  env: Record<string, string>;
  exportHint: string;
}

/** Production deps: readline prompts, fetch, Bun.spawn. Closes its readline via close(). */
export function realDeps(root: string): OnboardDeps & { close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const dataDir = process.env.LOOM_DATA_DIR || join(root, "data");
  const serveLogFile = join(dataDir, "ollama-serve.log");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    ask: (qq: string) => rl.question(qq),
    say: (s: string) => console.log(s),
    httpGet: async (url: string) => {
      const r = await fetch(url);
      return { ok: r.ok, json: () => r.json() as Promise<any> };
    },
    run: async (cmd: string[], opts?: { inherit?: boolean }) => {
      const proc = Bun.spawn(cmd, {
        stdout: opts?.inherit ? "inherit" : "pipe",
        stderr: opts?.inherit ? "inherit" : "pipe",
        stdin: "ignore",
      });
      return { code: await proc.exited };
    },
    spawnDetached: (cmd: string[], logFile: string) => {
      mkdirSync(dirname(logFile), { recursive: true });
      // double-fork: the shell exits at once, ollama serve keeps running orphaned
      const proc = Bun.spawn(["sh", "-c", `${cmd.map(q).join(" ")} >> ${q(logFile)} 2>&1 &`], {
        stdout: "ignore", stderr: "ignore", stdin: "ignore",
      });
      proc.unref();
    },
    ollamaBin: Bun.which("ollama"),
    baseUrl: "http://localhost:11434",
    modelName: "qwen3.5:2b",
    modelFile: join(root, "models", "qwen3.5-2b-tool.json"),
    thinkerScript: join(root, "examples", "thinker-model.sh"),
    serveLogFile,
    close: () => rl.close(),
  };
}

async function yes(deps: OnboardDeps, q: string): Promise<boolean> {
  const a = (await deps.ask(`${q} [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

async function serverUp(deps: OnboardDeps): Promise<boolean> {
  try {
    const r = await deps.httpGet(`${deps.baseUrl}/api/version`);
    return r.ok;
  } catch { return false; }
}

async function modelPresent(deps: OnboardDeps): Promise<boolean> {
  try {
    const r = await deps.httpGet(`${deps.baseUrl}/api/tags`);
    if (!r.ok) return false;
    const d = await r.json();
    const models: any[] = d.models || [];
    return models.some((m) => {
      const n = String(m.name || "");
      return n === deps.modelName || n.startsWith(deps.modelName + ":");
    });
  } catch { return false; }
}

export async function runOnboarding(deps: OnboardDeps): Promise<OnboardResult | null> {
  deps.say("no thinker configured — let's set up local Ollama (qwen3.5:2b).");

  if (!deps.ollamaBin) {
    deps.say("the `ollama` binary isn't on PATH. install it from https://ollama.com, then re-run `loom chat`.");
    return null;
  }
  deps.say(`ollama found: ${deps.ollamaBin}`);

  if (!(await serverUp(deps))) {
    deps.say(`ollama isn't responding at ${deps.baseUrl}.`);
    if (await yes(deps, "start `ollama serve` in the background now?")) {
      deps.spawnDetached([deps.ollamaBin, "serve"], deps.serveLogFile);
      const tries = deps.pollTries ?? 30, ms = deps.pollMs ?? 500;
      let up = false;
      for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, ms));
        if (await serverUp(deps)) { up = true; break; }
      }
      if (!up) {
        deps.say(`still no response — start it yourself with \`ollama serve\` (log: ${deps.serveLogFile}) and re-run.`);
        return null;
      }
    } else {
      deps.say("ok — start it yourself with `ollama serve` and re-run `loom chat`.");
      return null;
    }
  }
  deps.say("ollama server is up.");

  if (!(await modelPresent(deps))) {
    deps.say(`model ${deps.modelName} isn't pulled yet (~2.7GB).`);
    if (await yes(deps, `pull ${deps.modelName} now?`)) {
      deps.say(`pulling ${deps.modelName} — this can take a few minutes…`);
      const r = await deps.run([deps.ollamaBin, "pull", deps.modelName], { inherit: true });
      if (r.code !== 0) {
        deps.say(`\`ollama pull\` failed (exit ${r.code}) — try it manually, then re-run.`);
        return null;
      }
    } else {
      deps.say(`ok — pull it yourself with \`ollama pull ${deps.modelName}\` and re-run.`);
      return null;
    }
  }
  deps.say(`${deps.modelName} is ready.`);

  const thinker = `sh ${deps.thinkerScript}`;
  const env = { LOOM_MODEL_FILE: deps.modelFile, LOOM_CONTEXT_BUDGET: "12288" };
  const exportHint =
    `to skip this setup next time, add to your shell rc:\n` +
    `  export LOOM_MODEL_FILE="${deps.modelFile}"\n` +
    `  export LOOM_CONTEXT_BUDGET=12288\n` +
    `  export LOOM_THINKER="sh ${deps.thinkerScript}"`;
  return { thinker, env, exportHint };
}
