/* chat/session.ts — a chat is a loom job with status 'chat' (the daemon ignores it).
   Messages persist to the ledger, so `loom log <id>` replays any conversation. */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { addLedger } from "../db";
import { think, thinkTimeout, type ThinkAction } from "../think";
import { runExec } from "../exec";
import { getEmbedder, recall } from "../vector";
import { loadRegistry, parseSlash, renderTemplate, runExecCommand, helpText, type Registry } from "./commands";
import { parseMentions, resolveAttachments, attachmentsSection, attachmentsSummary } from "./attachments";

/** Max tool rounds before chat asks the thinker to just reply. */
const CHAT_MAX_TOOL_ROUNDS = 5;
/** exec inside chat defaults to 60s, never more than 120s. */
const CHAT_EXEC_TIMEOUT_S = 60;
const CHAT_EXEC_TIMEOUT_MAX_S = 120;

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

  /** Append a message (also persisted to the ledger). Public so the TUI can surface notices. */
  push(role: Message["role"], text: string): void {
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
    const mentions = parseMentions(t);
    const atts = resolveAttachments(mentions, process.cwd());
    const attachSection = attachmentsSection(atts);
    if (atts.length) this.push("system", attachmentsSummary(atts));
    let ctx =
      "# SYSTEM\nYou are loom chat: a terse, helpful terminal assistant. " +
      "You can use tools before replying: {\"action\":\"read\",\"path\":\"...\"} to read a file, " +
      "{\"action\":\"exec\",\"cmd\":\"...\"} to run a shell command, " +
      "{\"action\":\"recall\",\"query\":\"...\"} to search memory. " +
      "When you have what you need, reply with exactly one JSON object: {\"action\":\"note\",\"text\":\"<your reply>\"}. " +
      "Keep replies short unless asked for detail.\n\n" +
      "# HISTORY\n" + (this.historyText() || "(none)") + "\n\n# MESSAGE\nuser: " + t +
      (attachSection ? "\n\n" + attachSection : "");

    // Agentic loop: run tool actions, feed observations back, until the
    // thinker replies with a note.
    for (let round = 0; round < CHAT_MAX_TOOL_ROUNDS; round++) {
      const tr = await think(this.thinker, ctx, { timeout_s: thinkTimeout(120) });
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
      const r = await this.execTool(a);
      this.push("system", `tool ${a.action}: ${r.text.slice(0, 300)}`);
      ctx += `\n\n# OBSERVATION (your "${a.action}" ${r.failed ? "failed" : "result"}):\n` +
        r.text.slice(0, 4000) +
        `\n\nContinue: use another tool if needed, otherwise reply with {"action":"note","text":"..."}.\n`;
    }
    const msg = "thinker kept using tools without replying — try asking again";
    this.push("system", msg);
    return { notice: msg };
  }

  /** Run a thinker tool action inside chat. write stays daemon-only. */
  private async execTool(a: ThinkAction): Promise<{ text: string; failed: boolean }> {
    switch (a.action) {
      case "read": {
        if (!a.path) return { text: "read needs path", failed: true };
        try {
          const buf = readFileSync(resolve(process.cwd(), a.path));
          if (buf.includes(0)) return { text: `read ${a.path}: binary, skipped`, failed: true };
          const off = a.offset ?? 0, lim = Math.min(a.limit ?? 120, 400);
          const all = buf.toString("utf8").split("\n");
          const lines = all.slice(off, off + lim).join("\n");
          return { text: `read ${a.path} (lines ${off}\u2013${off + lim} of ${all.length}):\n${lines}`, failed: false };
        } catch (e: any) {
          return { text: `read ${a.path}: ${e.message}`, failed: true };
        }
      }
      case "exec": {
        if (!a.cmd) return { text: "exec needs cmd", failed: true };
        const r = await runExec(a.cmd, { timeout_s: Math.min(a.timeout_s ?? CHAT_EXEC_TIMEOUT_S, CHAT_EXEC_TIMEOUT_MAX_S) });
        return {
          text: `exec ${r.timedOut ? "TIMED OUT" : "exit " + r.code} (${r.ms}ms):\n${r.head}`,
          failed: r.timedOut || r.code !== 0,
        };
      }
      case "recall": {
        const q = (a.query || "").trim();
        if (!q) return { text: "recall needs query", failed: true };
        try {
          const hits = await recall(this.db, this.jobId, q, Math.min(Math.max(a.k ?? 3, 1), 5), getEmbedder());
          return {
            text: hits.length
              ? "recall results:\n\n" + hits.map((h) => `[${h.kind} ${h.ref}]\n${h.text.slice(0, 1500)}`).join("\n\n")
              : "recall: no indexed memory yet for this query",
            failed: false,
          };
        } catch (e: any) {
          return { text: `recall failed: ${e.message}`, failed: true };
        }
      }
      default:
        return { text: `chat can't run "${a.action}" \u2014 reply with a note instead`, failed: true };
    }
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
        const tr = await think(this.thinker, prompt, { timeout_s: thinkTimeout(120) });
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
