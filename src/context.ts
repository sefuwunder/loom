/* context.ts — build the thinker's prompt under a hard byte budget. */
import { Database } from "bun:sqlite";

/** Total budget for everything handed to the thinker. Small enough for <4GB rigs.
 *  Overridable per model file via LOOM_CONTEXT_BUDGET (bytes, min 2048).
 *  The qwen3.5:2b tool model file recommends 12288. */
export function getContextBudget(): number {
  const raw = process.env.LOOM_CONTEXT_BUDGET;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 2048) return n;
  }
  return 16 * 1024;
}

/** Budget evaluated at import time; prefer getContextBudget() for live reads. */
export const CONTEXT_BUDGET = getContextBudget();

export interface ContextOpts {
  goalBudget?: number;
  ledgerBudget?: number;
  lastResultBudget?: number;
  ledgerKinds?: string[];
}

/**
 * Assemble context oldest-priority-truncated: goal, plan, ledger tail, last result.
 * Returns text guaranteed <= budget bytes (UTF-8).
 */
export function buildContext(
  db: Database,
  jobId: string,
  goal: string,
  plan: string | null,
  lastResult: string | null,
  extraSystem: string | null,
  opts: ContextOpts = {},
): string {
  // Per-section budgets sum under the budget. The action protocol goes
  // FIRST and is never clipped — it is the one part the thinker must see.
  const budget = getContextBudget();
  const protocol =
    "# YOUR MOVE — reply with exactly one JSON object, no prose outside it:\n" +
    '{"action":"exec","cmd":"...","label":"..."} — run a shell command (timeout_s optional, default 120)\n' +
    '{"action":"read","path":"...","offset":0,"limit":60} — read a file excerpt (capped)\n' +
    '{"action":"write","path":"...","content":"..."} — write a file (200KB cap, recorded)\n' +
    '{"action":"note","text":"..."} — record an observation or decision\n' +
    '{"action":"recall","query":"...","k":3} — search this job\'s vector memory for relevant past steps/notes\n' +
    '{"action":"finish","summary":"..."} — job complete\n' +
    '{"action":"blocked","reason":"..."} — cannot proceed, needs the human';
  const protocolBytes = Buffer.byteLength(protocol, "utf8");
  const rest = budget - protocolBytes;

  const goalBudget = Math.min(opts.goalBudget ?? 2048, Math.floor(rest * 0.15));
  const planBudget = Math.floor(rest * 0.12);
  const systemBudget = Math.floor(rest * 0.06);
  const historyBudget = Math.floor(rest * 0.42);
  const resultBudget = rest - goalBudget - planBudget - systemBudget - historyBudget;

  const parts: string[] = [protocol];
  parts.push("# GOAL\n" + clip(goal, goalBudget));
  if (plan) parts.push("# PLAN (advisory)\n" + clip(plan, planBudget));
  if (extraSystem) parts.push("# SYSTEM\n" + clip(extraSystem, systemBudget));

  // ledger tail, newest-first fill until ledgerBudget
  const kinds = opts.ledgerKinds;
  const rows = db.query(
    `SELECT kind, text FROM ledger WHERE job_id = ? ${kinds ? `AND kind IN (${kinds.map(() => "?").join(",")})` : ""} ORDER BY seq DESC LIMIT 60`
  ).all(jobId, ...(kinds ?? [])) as Array<{ kind: string; text: string }>;

  const lines: string[] = [];
  let used = 0;
  for (const r of rows.reverse()) {
    const line = `[${r.kind}] ${r.text}`;
    if (used + line.length > historyBudget) {
      lines.push("…(older history truncated)…");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length) parts.push("# HISTORY (oldest → newest)\n" + lines.join("\n"));

  if (lastResult) parts.push("# LAST ACTION RESULT\n" + clip(lastResult, resultBudget));

  const out = parts.join("\n\n");
  // Safety net: should already be under budget given per-section caps.
  if (Buffer.byteLength(out, "utf8") > budget) {
    return protocol + "\n\n" + clip(parts.slice(1).join("\n\n"), budget - protocolBytes - 64) +
      "\n…(context truncated to budget)…";
  }
  return out;
}

function clip(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8").slice(0, maxBytes);
  return buf.toString("utf8") + "…";
}
