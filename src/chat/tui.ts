/* chat/tui.ts — Pi-style minimal full-screen terminal chat. Zero deps.
   Alternate buffer, one-line input with editing + history + tab completion,
   PgUp/PgDn scrollback. Terminal is always restored on exit. */
import { wrap, truncateVis, dim, accent, userPrefix, botPrefix } from "./text";
import { completePath } from "./attachments";
import type { ChatSession } from "./session";

type Key =
  | { type: "char"; ch: string } | { type: "enter" } | { type: "backspace" } | { type: "delete" }
  | { type: "left" } | { type: "right" } | { type: "up" } | { type: "down" }
  | { type: "home" } | { type: "end" } | { type: "pgup" } | { type: "pgdn" }
  | { type: "tab" } | { type: "ctrlc" } | { type: "ctrlu" } | { type: "ctrlk" }
  | { type: "ctrlw" } | { type: "ctrla" } | { type: "ctrle" } | { type: "esc" };

/** Parse complete keys from a buffer; return keys + unparsed remainder. */
export function parseKeys(buf: string): { keys: Key[]; rest: string } {
  const keys: Key[] = [];
  let i = 0;
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === "\x1b") {
      const seq = buf.slice(i);
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(seq);
      if (m && m[0].length <= seq.length) {
        const code = m[2];
        const num = m[1];
        if (code === "A") keys.push({ type: "up" });
        else if (code === "B") keys.push({ type: "down" });
        else if (code === "C") keys.push({ type: "right" });
        else if (code === "D") keys.push({ type: "left" });
        else if (code === "H" || (code === "~" && (num === "1" || num === "7"))) keys.push({ type: "home" });
        else if (code === "F" || (code === "~" && (num === "4" || num === "8"))) keys.push({ type: "end" });
        else if (code === "~" && num === "3") keys.push({ type: "delete" });
        else if (code === "~" && num === "5") keys.push({ type: "pgup" });
        else if (code === "~" && num === "6") keys.push({ type: "pgdn" });
        i += m[0].length;
        continue;
      }
      if (seq === "\x1b") break; // incomplete — wait for more
      keys.push({ type: "esc" });
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") { keys.push({ type: "enter" }); i++; continue; }
    if (ch === "\x7f") { keys.push({ type: "backspace" }); i++; continue; }
    if (ch === "\t") { keys.push({ type: "tab" }); i++; continue; }
    if (ch === "\x03") { keys.push({ type: "ctrlc" }); i++; continue; }
    if (ch === "\x15") { keys.push({ type: "ctrlu" }); i++; continue; }
    if (ch === "\x0b") { keys.push({ type: "ctrlk" }); i++; continue; }
    if (ch === "\x17") { keys.push({ type: "ctrlw" }); i++; continue; }
    if (ch === "\x01") { keys.push({ type: "ctrla" }); i++; continue; }
    if (ch === "\x05") { keys.push({ type: "ctrle" }); i++; continue; }
    if (ch >= " ") { keys.push({ type: "char", ch }); i++; continue; }
    i++; // ignore other control chars
  }
  return { keys, rest: buf.slice(i) };
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

export class Tui {
  session: ChatSession;
  input = "";
  cursor = 0;
  history: string[] = [];
  histIdx = -1;
  scroll = 0;          // lines scrolled up from bottom
  statusOverride: string | null = null;
  thinking = false;
  done = false;
  width = 80;
  height = 24;
  private buf = "";
  private escTimer: any = null;

  constructor(session: ChatSession) {
    this.session = session;
  }

  size(): void {
    try {
      const [w, h] = (process.stdout as any).getWindowSize() as [number, number];
      this.width = Math.max(40, w || 80);
      this.height = Math.max(12, h || 24);
    } catch { /* keep defaults */ }
  }

  /** Flatten messages to rendered lines. */
  lines(): string[] {
    const w = this.width - 2;
    const out: string[] = [];
    const msgs = this.session.messages.slice(-200);
    for (const m of msgs) {
      if (m.role === "user") {
        out.push(`${userPrefix()} ${accent("you")}`);
        for (const l of wrap(m.text, w)) out.push("  " + l);
      } else if (m.role === "assistant") {
        out.push(`${botPrefix()} ${accent("loom")}`);
        for (const l of wrap(m.text, w)) out.push("  " + l);
      } else {
        for (const l of wrap(m.text, w)) out.push(dim("· " + l));
      }
      out.push("");
    }
    return out;
  }

  render(): void {
    this.size();
    const w = this.width, h = this.height;
    const chrome = 3; // divider + input + status
    const viewH = h - chrome;
    const all = this.lines();
    const start = Math.max(0, all.length - viewH - this.scroll);
    const vis = all.slice(start, start + viewH);

    let s = "\x1b[H" + HIDE;
    for (let r = 0; r < viewH; r++) {
      s += "\x1b[K" + (vis[r] ?? "");
      if (r < viewH - 1) s += "\r\n";
    }
    s += "\r\n\x1b[K" + dim("─".repeat(w));
    // input row
    const prompt = "› ";
    const maxIn = w - prompt.length - 1;
    let viewStart = 0;
    if (this.cursor - viewStart >= maxIn) viewStart = this.cursor - maxIn + 1;
    if (viewStart > 0) viewStart = Math.max(0, this.cursor - maxIn + 1);
    const slice = this.input.slice(viewStart, viewStart + maxIn);
    s += "\r\n\x1b[K" + accent(prompt) + slice;
    // status row
    const scrolled = this.scroll > 0 ? " · ▲ scrolled (PgDn to bottom)" : "";
    const status = this.statusOverride ??
      `loom chat · ${this.session.messages.length} messages · /help · Ctrl+C quit${scrolled}`;
    s += "\r\n\x1b[K" + dim(truncateVis(status, w));
    // place cursor
    const cx = prompt.length + (this.cursor - viewStart) + 1;
    s += `\x1b[${viewH + 2};${Math.min(cx, w)}H` + SHOW;
    process.stdout.write(s);
  }

  complete(): void {
    const m = /^\/([a-z0-9_-]*)$/.exec(this.input);
    if (m) {
      const names = [...this.session.registry.commands.keys()].filter((n) => n.startsWith(m[1]));
      if (names.length === 1) {
        this.input = "/" + names[0] + " ";
        this.cursor = this.input.length;
      } else if (names.length > 1) {
        this.statusOverride = "candidates: " + names.map((n) => "/" + n).join(" ");
        setTimeout(() => { this.statusOverride = null; if (!this.done) this.render(); }, 2500);
      }
      return;
    }
    // @path completion on the token before the cursor
    const before = this.input.slice(0, this.cursor);
    const am = /(^|[\s([{"'])@([^\s@]*)$/.exec(before);
    if (!am) return;
    const frag = am[2];
    const cands = completePath(frag, process.cwd());
    if (cands.length === 1) {
      const done = before.slice(0, before.length - frag.length) + cands[0] + (cands[0].endsWith("/") ? "" : " ");
      this.input = done + this.input.slice(this.cursor);
      this.cursor = done.length;
    } else if (cands.length > 1) {
      this.statusOverride = "candidates: " + cands.map((c) => "@" + c).join(" ");
      setTimeout(() => { this.statusOverride = null; if (!this.done) this.render(); }, 2500);
    }
  }

  async onKey(k: Key): Promise<void> {
    if (this.thinking) return; // input locked while the thinker works
    switch (k.type) {
      case "char":
        this.input = this.input.slice(0, this.cursor) + k.ch + this.input.slice(this.cursor);
        this.cursor += k.ch.length;
        this.histIdx = -1;
        break;
      case "backspace":
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor--;
        }
        break;
      case "delete":
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        break;
      case "left": this.cursor = Math.max(0, this.cursor - 1); break;
      case "right": this.cursor = Math.min(this.input.length, this.cursor + 1); break;
      case "home": case "ctrla": this.cursor = 0; break;
      case "end": case "ctrle": this.cursor = this.input.length; break;
      case "ctrlu": this.input = this.input.slice(this.cursor); this.cursor = 0; break;
      case "ctrlk": this.input = this.input.slice(0, this.cursor); break;
      case "ctrlw": {
        const cut = this.input.slice(0, this.cursor).replace(/\s*\S+\s*$/, "");
        this.cursor = cut.length;
        this.input = cut + this.input.slice(this.cursor);
        break;
      }
      case "up":
        if (this.histIdx < this.history.length - 1) {
          this.histIdx++;
          this.input = this.history[this.history.length - 1 - this.histIdx];
          this.cursor = this.input.length;
        }
        break;
      case "down":
        if (this.histIdx > 0) {
          this.histIdx--;
          this.input = this.history[this.history.length - 1 - this.histIdx];
          this.cursor = this.input.length;
        } else { this.histIdx = -1; this.input = ""; this.cursor = 0; }
        break;
      case "pgup": this.scroll += Math.max(1, this.height - 8); this.render(); return;
      case "pgdn": this.scroll = Math.max(0, this.scroll - Math.max(1, this.height - 8)); this.render(); return;
      case "tab": this.complete(); break;
      case "esc": case "ctrlc": this.done = true; return;
      case "enter": await this.send(); return;
    }
    this.render();
  }

  async send(): Promise<void> {
    const line = this.input;
    this.input = ""; this.cursor = 0; this.histIdx = -1; this.scroll = 0;
    if (line.trim()) this.history.push(line);
    this.thinking = true;
    this.statusOverride = "thinking…";
    this.render();
    try {
      const r = await this.session.handle(line);
      if (r.quit) { this.done = true; return; }
      if (r.notice) this.session.push("system", r.notice);
    } finally {
      this.thinking = false;
      this.statusOverride = null;
    }
    this.render();
  }

  onData = (chunk: string): void => {
    this.buf += chunk;
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
    const { keys, rest } = parseKeys(this.buf);
    this.buf = rest;
    if (this.buf === "\x1b") {
      // trailing lone ESC: maybe the user pressed Esc, maybe a sequence is
      // still arriving — wait briefly before deciding
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        this.buf = "";
        void this.onKey({ type: "esc" });
      }, 60);
    }
    void (async () => { for (const k of keys) { await this.onKey(k); if (this.done) break; } })();
  };

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("loom chat needs a terminal");
    }
    process.stdout.write(ALT_ON);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onResize = () => this.render();
    (process.stdout as any).on("resize", onResize);

    const teardown = () => {
      try {
        if (this.escTimer) clearTimeout(this.escTimer);
        stdin.removeListener("data", this.onData);
        (process.stdout as any).removeListener("resize", onResize);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write(SHOW + ALT_OFF);
      } catch { /* best effort */ }
    };
    const sig = () => { teardown(); process.exit(130); };
    process.on("SIGINT", sig);
    process.on("SIGTERM", sig);

    try {
      stdin.on("data", this.onData);
      this.session.messages.push({
        role: "system",
        text: `loom chat — talking to ${this.session.thinker}. /help for commands, @path to attach files, /quit to exit.`,
      });
      this.render();
      while (!this.done) await Bun.sleep(50);
    } finally {
      process.removeListener("SIGINT", sig);
      process.removeListener("SIGTERM", sig);
      teardown();
    }
  }
}
