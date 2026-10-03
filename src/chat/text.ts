/* chat/text.ts — word wrap and small terminal helpers. Pure functions. */

export function wrap(text: string, width: number): string[] {
  if (width < 8) width = 8;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = "";
    for (const w of words) {
      if (/^\s+$/.test(w)) {
        if ((line + w).length > width) { out.push(line); line = ""; }
        else line += w;
        continue;
      }
      if (w.length > width) {
        // hard-break long words
        if (line) { out.push(line); line = ""; }
        for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
        continue;
      }
      if ((line + w).length > width) { out.push(line); line = ""; }
      line += w;
    }
    out.push(line);
  }
  return out;
}

/** Visible width ignoring ANSI escapes. */
export function visWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function truncateVis(s: string, width: number): string {
  if (visWidth(s) <= width) return s;
  let out = "", w = 0, i = 0;
  while (i < s.length && w < width - 1) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += s[i]; w++; i++;
  }
  return out + "…";
}

const NO_COLOR = !!process.env.NO_COLOR;
const c = (code: string, s: string) => NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`;
export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);
export const accent = (s: string) => c("38;5;209", s); // terracotta
export const userPrefix = () => accent("›");
export const botPrefix = () => accent("◈");
