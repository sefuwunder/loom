/* chat/attachments.ts — @file and @folder mentions in chat input.
   `@path` tokens in a message are expanded into the thinker prompt: files are
   inlined (capped), folders become a capped listing. The displayed message
   keeps the @path as typed. */

import { statSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

export const FILE_CAP = 32 * 1024;   // max bytes inlined per file
export const DIR_MAX_ENTRIES = 100;  // max entries listed per folder
export const MAX_MENTIONS = 10;      // max @paths expanded per message

export interface Attachment {
  path: string;                  // as typed (relative)
  kind: "file" | "dir" | "missing";
  text: string;                  // rendered block for the prompt
  bytes: number;                 // bytes inlined (0 for missing)
}

/** Find @path tokens. Skips emails (a@b.com) and dedupes. Strips trailing punctuation. */
export function parseMentions(input: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s([{"'])@([^\s@][^\s]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const p = m[2].replace(/[.,;:!?)\]}'"]+$/, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

function listDir(abs: string, rel: string): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (lines.length >= DIR_MAX_ENTRIES || depth > 2) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const e of entries) {
      if (lines.length >= DIR_MAX_ENTRIES) break;
      if (e.startsWith(".") || e === "node_modules") continue;
      const full = join(dir, e);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      lines.push(`${prefix}${e}${isDir ? "/" : ""}`);
      if (isDir) walk(full, `${prefix}${e}/`, depth + 1);
    }
  };
  walk(abs, "", 0);
  const clipped = lines.length >= DIR_MAX_ENTRIES;
  return `--- @${rel}/ (folder, ${lines.length} entries${clipped ? ", truncated" : ""}) ---\n` + lines.join("\n");
}

export function resolveAttachments(paths: string[], cwd: string): Attachment[] {
  const out: Attachment[] = [];
  for (const p of paths.slice(0, MAX_MENTIONS)) {
    const abs = resolve(cwd, p);
    const rel = relative(cwd, abs) || ".";
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(abs); } catch { /* missing */ }
    if (!st) {
      out.push({ path: p, kind: "missing", text: `@${p}: not found`, bytes: 0 });
      continue;
    }
    if (st.isDirectory()) {
      const text = listDir(abs, rel.split(sep).join("/"));
      out.push({ path: p, kind: "dir", text, bytes: Buffer.byteLength(text, "utf8") });
      continue;
    }
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch {
      out.push({ path: p, kind: "missing", text: `@${p}: unreadable`, bytes: 0 });
      continue;
    }
    if (buf.includes(0)) {
      out.push({ path: p, kind: "file", text: `--- @${rel} (file, ${fmtBytes(buf.length)}, binary skipped) ---`, bytes: 0 });
      continue;
    }
    const clipped = buf.length > FILE_CAP;
    const content = (clipped ? buf.slice(0, FILE_CAP).toString("utf8") + `\n…(${fmtBytes(buf.length)} total, truncated)…` : buf.toString("utf8"));
    const text = `--- @${rel} (file, ${fmtBytes(buf.length)}) ---\n${content}`;
    out.push({ path: p, kind: "file", text, bytes: Math.min(buf.length, FILE_CAP) });
  }
  return out;
}

/** Render the prompt section for resolved attachments. */
export function attachmentsSection(atts: Attachment[]): string {
  if (!atts.length) return "";
  return "# ATTACHMENTS\n" + atts.map((a) => a.text).join("\n\n");
}

/** One-line summary for the chat view, e.g. "attached @a.ts (1.2KB), @docs/ (14 entries)". */
export function attachmentsSummary(atts: Attachment[]): string {
  return "attached " + atts.map((a) =>
    a.kind === "missing" ? `@${a.path} (not found)`
    : a.kind === "dir" ? `@${a.path}/`
    : `@${a.path} (${fmtBytes(a.bytes)})`).join(", ");
}

/** Complete a path fragment for @-mention tab completion. Returns candidates (dirs end with /). */
export function completePath(frag: string, cwd: string): string[] {
  const lastSlash = frag.lastIndexOf("/");
  const dirFrag = lastSlash < 0 ? "" : frag.slice(0, lastSlash + 1);
  const base = lastSlash < 0 ? frag : frag.slice(lastSlash + 1);
  let entries: string[];
  try { entries = readdirSync(resolve(cwd, dirFrag || ".")); } catch { return []; }
  return entries
    .filter((e) => !e.startsWith(".") && e.toLowerCase().startsWith(base.toLowerCase()))
    .sort()
    .map((e) => {
      let isDir = false;
      try { isDir = statSync(resolve(cwd, dirFrag, e)).isDirectory(); } catch {}
      return dirFrag + e + (isDir ? "/" : "");
    });
}
