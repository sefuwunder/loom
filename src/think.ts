/* think.ts — the thinker protocol. JSON in on stdin, one JSON object on stdout.
   The thinker is any executable (a model CLI, a script, a human-in-the-loop).
   Ephemeral: spawned fresh per turn, killed on timeout. Nothing persists in RAM. */
import { createHash } from "node:crypto";

export interface ThinkAction {
  action: "exec" | "read" | "write" | "note" | "finish" | "blocked";
  cmd?: string;
  path?: string;
  offset?: number;
  limit?: number;
  content?: string;
  label?: string;
  text?: string;
  summary?: string;
  reason?: string;
  timeout_s?: number;
}

export interface ThinkResult {
  ok: boolean;
  action?: ThinkAction;
  raw: string;
  ms: number;
  timedOut: boolean;
  error?: string;
}

const VALID = new Set(["exec", "read", "write", "note", "finish", "blocked"]);

/** Run the thinker command with the context on stdin; parse one JSON object from stdout. */
export async function think(
  thinkerCmd: string,
  context: string,
  opts: { timeout_s?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<ThinkResult> {
  const t0 = Date.now();
  const timeoutMs = (opts.timeout_s ?? 300) * 1000;
  const proc = Bun.spawn(["sh", "-c", thinkerCmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(context);
  proc.stdin.end();

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch {}
  }, timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  const ms = Date.now() - t0;

  if (timedOut) {
    return { ok: false, raw: "", ms, timedOut: true, error: `thinker timed out after ${opts.timeout_s ?? 300}s` };
  }

  const raw = stdout.trim();
  const parsed = extractJson(raw);
  if (!parsed) {
    return { ok: false, raw: raw.slice(0, 2000), ms, timedOut: false, error: `thinker did not emit JSON (exit ${code}, stderr: ${stderr.slice(0, 300)})` };
  }
  if (!parsed.action || !VALID.has(String(parsed.action))) {
    return { ok: false, raw: raw.slice(0, 2000), ms, timedOut: false, error: `invalid action: ${JSON.stringify(parsed.action)}` };
  }
  return { ok: true, action: parsed as ThinkAction, raw: raw.slice(0, 2000), ms, timedOut: false };
}

/** Find the first {...} JSON object in the output (tolerates surrounding prose). */
export function extractJson(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}

export function hashText(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);
}
