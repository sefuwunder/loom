/* chat/session.ts — a chat is a loom job with status 'chat' (the daemon ignores it).
   Messages persist to the ledger, so `loom log <id>` replays any conversation. */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { addLedger } from "../db";
import { think } from "../think";
import { loadRegistry, parseSlash, renderTemplate, runExecCommand, helpText, type Registry } from "./commands";

export interface Message {
  role: "user" | "assistant" | "system";
  text: string;
}

const HISTORY_BUDGET = 8192;

export class ChatSession {
  db: Database;
  jobId: string;
  thinker: string;
  registry!: Registry;
  messages: Message[] = [];
  commandsDir: string;

  constructor(db: Database, thinker: string, commandsDir: string) {
    this.db = db;
    this.thinker = thinker;
    this.commandsDir = commandsDir;
    const now = new Date();
    this.jobId = "chat_" + now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ts = Date.now();
    db.query(`INSERT INTO jobs (id, name, goal, status, thinker, created_at, updated_at, heartbeat_at)
              VALUES (?, ?, ?, 'chat', ?, ?, ?, ?)`)
      .run(this.jobId, `chat ${now.toLocaleString()}`, "interactive chat session", thinker, ts, ts, ts);
  }

  async init(): Promise<void> {
    this.registry = await loadRegistry(this.commandsDir);
  }

  historyText(): string {
    const lines: string[] = [];
    let used = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "system") continue;
      const line = `${m.role}: ${m.text}`;
      if (used + line.length > HISTORY_BUDGET) break;
      lines.unshift(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  private push(role: Message["role"], text: string): void {
    this.messages.push({ role, text });
    addLedger(this.db, this.jobId, role === "user" ? "user" : role === "assistant" ? "assistant" : "system", text.slice(0, 4000));
  }

  clear(): void {
    this.messages = [];
    addLedger(this.db, this.jobId, "system", "conversation cleared");
  }

  /** Handle one input line. Returns {quit} or {reply} / {notice} to display. */
  async handle(line: string): Promise<{ quit?: boolean; notice?: string; reply?: string }> {
    const t = line.trim();
    if (!t) return {};
    const slash = parseSlash(t);
    if (slash) return this.handleSlash(slash.name, slash.args);

    this.push("user", t);
    const ctx =
      "# SYSTEM\nYou are loom chat: a terse, helpful terminal assistant. " +
      "Reply with exactly one JSON object and nothing else: {\"action\":\"note\",\"text\":\"<your reply>\"}. " +
      "Keep replies short unless asked for detail.\n\n" +
      "# HISTORY\n" + (this.historyText() || "(none)") + "\n\n# MESSAGE\nuser: " + t;

    const tr = await think(this.thinker, ctx, { timeout_s: 120 });
    if (!tr.ok || !tr.action) {
      const msg = `thinker error: ${tr.error || "unknown"}`;
      this.push("system", msg);
      return { notice: msg };
    }
    const a = tr.action;
    if (a.action === "note" || a.action === "finish" || a.action === "blocked") {
      const text = a.text || a.summary || a.reason || "(empty reply)";
      this.push("assistant", text);
      return { reply: text };
    }
    const msg = `thinker returned action "${a.action}" — chat only displays replies`;
    this.push("system", msg);
    return { notice: msg };
  }

  private async handleSlash(name: string, args: string): Promise<{ quit?: boolean; notice?: string; reply?: string }> {
    const def = this.registry.commands.get(name);
    if (!def) return { notice: `unknown command /${name} — try /help` };
    const ctx = { historyText: this.historyText(), args };

    switch (def.kind) {
      case "builtin":
        if (name === "help") return { notice: helpText(this.registry) };
        if (name === "quit" || name === "q" || name === "exit") return { quit: true };
        if (name === "clear") { this.clear(); return { notice: "cleared" }; }
        if (name === "thinker") return { notice: `thinker: ${this.thinker}` };
        if (name === "save") {
          const p = args || defaultTranscriptPath(this.jobId);
          const { dirname } = await import("node:path");
          mkdirSync(dirname(p), { recursive: true });
          await Bun.write(p, this.transcript());
          return { notice: `saved to ${p}` };
        }
        return { notice: `unknown builtin /${name}` };
      case "prompt": {
        const rendered = renderTemplate(def.template || "", ctx);
        this.push("user", `/${name} ${args}`.trim());
        const prompt = "# SYSTEM\nYou are loom chat. Reply with exactly one JSON object and nothing else: {\"action\":\"note\",\"text\":\"<your reply>\"}.\n\n# REQUEST\n" + rendered;
        const tr = await think(this.thinker, prompt, { timeout_s: 120 });
        if (!tr.ok || !tr.action || (tr.action.action !== "note" && tr.action.action !== "finish")) {
          return { notice: `command failed: ${tr.error || "bad reply"}` };
        }
        const text = tr.action.text || tr.action.summary || "(empty)";
        this.push("assistant", text);
        return { reply: text };
      }
      case "exec": {
        const out = await runExecCommand(def, ctx);
        this.push("system", `/${name} output:\n${out.slice(0, 2000)}`);
        return { notice: out };
      }
    }
    return {};
  }

  transcript(): string {
    const lines = [`# loom chat ${this.jobId}`, ""];
    for (const m of this.messages) {
      lines.push(m.role === "user" ? `**you:** ${m.text}` : m.role === "assistant" ? `**loom:** ${m.text}` : `_${m.text}_`);
      lines.push("");
    }
    return lines.join("\n");
  }
}

export function defaultTranscriptPath(jobId: string): string {
  const dir = process.env.LOOM_DATA_DIR || "data";
  return join(dir, "chats", `${jobId}.md`);
}

export function defaultCommandsDir(): string {
  if (process.env.LOOM_COMMANDS_DIR) return process.env.LOOM_COMMANDS_DIR;
  return join(process.env.LOOM_DATA_DIR || "data", "commands");
}
