/* spin.ts — the anti-loop core. Pure functions, no I/O. */
import { createHash } from "node:crypto";

export interface Action {
  action: string;
  [k: string]: unknown;
}

/** Canonical fingerprint: same intent + same arguments => same fingerprint. */
export function fingerprint(a: Action): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) o[k] = norm((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  // volatile fields never count toward identity
  const { _meta, timeout_s, ...rest } = a;
  void _meta; void timeout_s;
  const canon = JSON.stringify({ action: a.action, args: norm(rest) });
  return createHash("sha1").update(canon).digest("hex").slice(0, 16);
}

export type SpinVerdict =
  | { kind: "ok" }
  | { kind: "strike"; strikes: number; fingerprint: string; reason: string }
  | { kind: "spin"; fingerprint: string; reason: string };

export interface SpinState {
  strikes: number;
  lastFp: string | null;
  lastOutputHash: string | null;
  repeatCount: number;
}

export const MAX_STRIKES = 3;

export function emptySpin(): SpinState {
  return { strikes: 0, lastFp: null, lastOutputHash: null, repeatCount: 0 };
}

/**
 * Observe one completed action. Returns:
 * - ok: productive or first-seen
 * - strike: same fingerprint as last action AND same output hash (no new information)
 * - spin: strikes hit MAX_STRIKES — the worker must replan or stop
 */
export function observe(s: SpinState, fp: string, outputHash: string): { state: SpinState; verdict: SpinVerdict } {
  const state: SpinState = { ...s };
  if (fp === s.lastFp) {
    state.repeatCount = s.repeatCount + 1;
    if (outputHash === s.lastOutputHash) {
      state.strikes = s.strikes + 1;
      state.lastOutputHash = outputHash;
      if (state.strikes >= MAX_STRIKES) {
        return { state, verdict: { kind: "spin", fingerprint: fp, reason: `repeated identical action ${state.repeatCount + 1}x with byte-identical output` } };
      }
      return { state, verdict: { kind: "strike", strikes: state.strikes, fingerprint: fp, reason: `repeat #${state.repeatCount + 1} with identical output` } };
    }
    // same action, different output => it is learning; decay strikes
    state.strikes = Math.max(0, s.strikes - 1);
    state.lastOutputHash = outputHash;
    return { state, verdict: { kind: "ok" } };
  }
  // new action resets the repeat counter; strikes decay slowly
  state.lastFp = fp;
  state.lastOutputHash = outputHash;
  state.repeatCount = 0;
  state.strikes = Math.max(0, s.strikes - 1);
  return { state, verdict: { kind: "ok" } };
}

/** System prompt injected when a spin is detected. */
export function replanPrompt(fp: string, reason: string): string {
  return [
    "SYSTEM: you are spinning in circles.",
    `The action you keep taking (${fp}) has ${reason}.`,
    "Do NOT repeat it. Either:",
    "  1. explain what is blocking you and emit {\"action\":\"blocked\",\"reason\":\"...\"}, or",
    "  2. take a genuinely different action that could produce new information.",
    "One more identical repeat ends this job.",
  ].join("\n");
}
