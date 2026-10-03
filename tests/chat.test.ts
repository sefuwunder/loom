/* chat.test.ts — slash parsing, registry, wrap, session. Run with bun. */
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSlash, loadRegistry, renderTemplate, helpText } from "../src/chat/commands";
import { wrap } from "../src/chat/text";
import { parseKeys, Tui } from "../src/chat/tui";
import { openDb } from "../src/db";
import { ChatSession } from "../src/chat/session";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

// slash parsing
ok(parseSlash("/help")?.name === "help", "parses /help");
ok(parseSlash("/save out.md")?.args === "out.md", "parses args");
ok(parseSlash("/SHOUT hi")?.name === "shout", "names lowercased");
ok(parseSlash("hello") === null, "non-slash ignored");
ok(parseSlash("/") === null, "bare slash ignored");

// word wrap
{
  const lines = wrap("aaaa bbbb cccc", 8);
  ok(lines.join("|") === "aaaa |bbbb |cccc", `wraps words (${lines.join("|")})`);
  const long = wrap("supercalifragilistic", 8);
  ok(long.every((l) => l.length <= 8), "hard-breaks long words");
  ok(wrap("a\n\nb", 10).join("|") === "a||b", "keeps paragraphs");
}

// key parsing
{
  const { keys, rest } = parseKeys("\x1b[A\x1b[3~\x7f");
  ok(keys.map((k) => k.type).join(",") === "up,delete,backspace" && rest === "", "parses escape sequences");
  const p2 = parseKeys("hi\x1b");
  ok(p2.keys.map((k: any) => k.ch || k.type).join("") === "hi" && p2.rest === "\x1b", "trailing ESC buffered");
  const p3 = parseKeys("\x03ab");
  ok(p3.keys[0].type === "ctrlc", "ctrl-c parsed");
}

// registry: builtins + .md + .sh files
const tmp = mkdtempSync(join(tmpdir(), "loom-chat-"));
{
  const cdir = join(tmp, "commands");
  mkdirSync(cdir, { recursive: true });
  await Bun.write(join(cdir, "summarize.md"), "# Summarize it\nSummarize:\n{{history}}\ninput was {{input}}");
  await Bun.write(join(cdir, "shout.sh"), "#!/bin/sh\necho \"$LOOM_ARGS\" | tr '[:lower:]' '[:upper:]'");
  await Bun.$`chmod +x ${join(cdir, "shout.sh")}`.quiet();
  const reg = await loadRegistry(cdir);
  ok(reg.commands.has("help") && reg.commands.has("summarize") && reg.commands.has("shout"), "registry loads builtins + files");
  ok(reg.commands.get("summarize")!.kind === "prompt", ".md -> prompt command");
  ok(reg.commands.get("shout")!.kind === "exec", ".sh -> exec command");
  const tpl = renderTemplate(reg.commands.get("summarize")!.template!, { historyText: "H", args: "A" });
  ok(tpl.includes("H") && tpl.includes("A") && !tpl.includes("{{"), "template renders placeholders");
  ok(helpText(reg).includes("/summarize") && helpText(reg).includes("/shout"), "help lists custom commands");
}

// session: chat round-trip with the fake thinker, slash commands, persistence
{
  process.env.LOOM_DATA_DIR = join(tmp, "data");
  const db = openDb(join(tmp, "chat.db"));
  const thinker = `sh ${join(import.meta.dir, "..", "examples", "thinker-fake.sh")}`;
  const cdir = join(tmp, "commands");
  const s = new ChatSession(db, thinker, cdir);
  await s.init();
  process.env.FAKE_MODE = "chat";
  process.env.FAKE_STATE_FILE = join(tmp, "chat-state");

  const r1 = await s.handle("hello there");
  ok(!!r1.reply && r1.reply.includes("fake reply"), `chat round-trip works (${r1.reply})`);
  const r2 = await s.handle("/shout make it loud");
  ok(!!r2.notice && r2.notice.trim() === "MAKE IT LOUD", `exec slash command runs (${r2.notice})`);
  const r3 = await s.handle("/nope");
  ok(!!r3.notice && r3.notice.includes("unknown command"), "unknown command reported");
  const r4 = await s.handle("/help");
  ok(!!r4.notice && r4.notice.includes("/summarize"), "/help lists commands");
  const before = s.messages.length;
  await s.handle("/clear");
  ok(s.messages.length < before, "/clear clears");

  // persisted: loom log replays the chat
  const n = (db.query(`SELECT COUNT(*) AS n FROM ledger WHERE job_id = ?`).get(s.jobId) as any).n;
  ok(n > 0, `conversation persisted to ledger (${n} entries)`);
  const st = (db.query(`SELECT status FROM jobs WHERE id = ?`).get(s.jobId) as any).status;
  ok(st === "chat", "chat job invisible to the daemon");

  // history bounded
  for (let i = 0; i < 50; i++) s.messages.push({ role: "user", text: "x".repeat(1000) });
  ok(Buffer.byteLength(s.historyText(), "utf8") <= 8192, "history text bounded");
  db.close();
}

// regression: TUI must surface notices (e.g. /help) — send() dropped them
{
  const db = openDb(join(tmp, "chat-tui.db"));
  const s = new ChatSession(db, `sh ${join(import.meta.dir, "..", "examples", "thinker-fake.sh")}`, join(tmp, "commands"));
  await s.init();
  const tui = new Tui(s);
  tui.render = () => {}; // no TTY in tests
  tui.input = "/help";
  await tui.send();
  ok(s.messages.some((m) => m.role === "system" && m.text.includes("/quit")), "tui surfaces /help notice");
  tui.input = "/thinker";
  await tui.send();
  ok(s.messages.some((m) => m.role === "system" && m.text.includes("thinker:")), "tui surfaces /thinker notice");
  tui.input = "/nope";
  await tui.send();
  ok(s.messages.some((m) => m.role === "system" && m.text.includes("unknown command")), "tui surfaces unknown-command notice");
  db.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
