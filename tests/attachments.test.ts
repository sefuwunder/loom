/* attachments.test.ts — @file/@folder mentions: parsing, resolving, completion. Run with bun. */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseMentions, resolveAttachments, attachmentsSection, attachmentsSummary,
  completePath, FILE_CAP,
} from "../src/chat/attachments";
import { openDb } from "../src/db";
import { ChatSession } from "../src/chat/session";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

// ---- parseMentions ----
ok(JSON.stringify(parseMentions("look at @app.ts")) === `["app.ts"]`, "parses @file");
ok(JSON.stringify(parseMentions("compare @a.ts and @b.ts")) === `["a.ts","b.ts"]`, "parses multiple");
ok(JSON.stringify(parseMentions("@a.ts then @a.ts")) === `["a.ts"]`, "dedupes");
ok(parseMentions("mail me at a@b.com").length === 0, "email not a mention");
ok(JSON.stringify(parseMentions("see @docs/.")) === `["docs/"]`, "trailing punctuation stripped");
ok(JSON.stringify(parseMentions("(@app.ts)")) === `["app.ts"]`, "paren-wrapped mention");
ok(JSON.stringify(parseMentions("fix @src/app.ts now")) === `["src/app.ts"]`, "nested path");
ok(parseMentions("no mentions here").length === 0, "no false positives");

// ---- resolveAttachments (in a fixture dir) ----
const tmp = mkdtempSync(join(tmpdir(), "loom-att-"));
const origCwd = process.cwd();
process.chdir(tmp);
writeFileSync("hello.txt", "hello world\nline two\n");
writeFileSync("big.bin", Buffer.from([0x41, 0x00, 0x42]));
writeFileSync("huge.txt", "x".repeat(FILE_CAP + 100));
mkdirSync("docs");
writeFileSync(join("docs", "a.md"), "# a");
writeFileSync(join("docs", "b.md"), "# b");

{
  const [f] = resolveAttachments(["hello.txt"], tmp);
  ok(f.kind === "file" && f.text.includes("hello world"), "file inlined");
  ok(f.text.startsWith("--- @hello.txt"), "file header names the path");
}
{
  const [m] = resolveAttachments(["nope.txt"], tmp);
  ok(m.kind === "missing" && m.text.includes("not found"), "missing reported");
}
{
  const [d] = resolveAttachments(["docs"], tmp);
  ok(d.kind === "dir" && d.text.includes("a.md") && d.text.includes("b.md"), "folder listed");
}
{
  const [b] = resolveAttachments(["big.bin"], tmp);
  ok(b.text.includes("binary skipped"), "binary skipped");
}
{
  const [h] = resolveAttachments(["huge.txt"], tmp);
  ok(h.text.includes("truncated") && h.bytes === FILE_CAP, "large file capped");
}
{
  const many = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
  const atts = resolveAttachments(many, tmp);
  ok(atts.length === 10, "mentions capped at 10 per message");
}
{
  const s = attachmentsSummary(resolveAttachments(["hello.txt", "docs", "nope.txt"], tmp));
  ok(s.includes("@hello.txt") && s.includes("@docs/") && s.includes("not found"), `summary readable (${s})`);
}
{
  const sec = attachmentsSection(resolveAttachments(["hello.txt"], tmp));
  ok(sec.startsWith("# ATTACHMENTS"), "section headed for the prompt");
  ok(attachmentsSection([]) === "", "empty section is empty");
}

// ---- completePath ----
{
  const c1 = completePath("hel", tmp);
  ok(c1.includes("hello.txt"), "completes file prefix");
  const c2 = completePath("do", tmp);
  ok(c2.includes("docs/"), "directory candidate ends with /");
  const c3 = completePath("docs/a", tmp);
  ok(JSON.stringify(c3) === `["docs/a.md"]`, "completes inside a folder");
  ok(completePath("zzz", tmp).length === 0, "no candidates for unknown prefix");
}

process.chdir(origCwd);

// ---- session integration: @mention reaches the thinker prompt ----
{
  const db = openDb(join(tmp, "att-chat.db"));
  const thinker = join(tmp, "thinker-dump.sh");
  const dumpFile = join(tmp, "dump.txt");
  await Bun.write(thinker, `#!/bin/sh\ncat > ${dumpFile}\nprintf '{"action":"note","text":"saw it"}\\n'\n`);
  await Bun.$`chmod +x ${thinker}`.quiet();
  const s = new ChatSession(db, `sh ${thinker}`, join(tmp, "commands"));
  await s.init();
  process.chdir(tmp);
  const r = await s.handle("explain @hello.txt please");
  process.chdir(origCwd);
  const prompt = await Bun.file(dumpFile).text();
  ok(prompt.includes("hello world"), "@file content expanded into thinker prompt");
  ok(prompt.includes("# ATTACHMENTS"), "attachments section present in prompt");
  ok(r.reply === "saw it", "reply still works with attachments");
  const userMsg = s.messages.find((m) => m.role === "user");
  ok(!!userMsg && userMsg.text === "explain @hello.txt please", "displayed message keeps @path as typed");
  ok(s.messages.some((m) => m.role === "system" && m.text.includes("attached @hello.txt")), "attachment summary shown");
  db.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
