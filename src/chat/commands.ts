/* chat/commands.ts — slash command registry. Builtins + user-programmable files.
   A command is either:
     <name>.md  — prompt template; {{input}} = args, {{history}} = bounded transcript
     <name>.sh  — executable; argv = args, env LOOM_ARGS / LOOM_HISTORY; stdout shown
   Directory: $LOOM_COMMANDS_DIR or <data>/commands. */

export interface ChatContext {
  historyText: string;   // bounded "user: ...\nassistant: ..." transcript
  args: string;          // text after the command name
}

export interface CommandDef {
  name: string;
  description: string;
  kind: "builtin" | "prompt" | "exec";
  run?: (ctx: ChatContext) => Promise<string> | string;
  // for file commands:
  path?: string;
  template?: string;
}

export interface Registry {
  commands: Map<string, CommandDef>;
  dir: string;
}

export function parseSlash(input: string): { name: string; args: string } | null {
  const t = input.trim();
  if (!t.startsWith("/")) return null;
  const m = /^\/([a-zA-Z0-9_-]+)\s*(.*)$/.exec(t);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2] };
}

const BUILTINS: Array<[string, string]> = [
  ["help", "list commands"],
  ["quit", "exit chat (aliases: /q, /exit)"],
  ["clear", "clear the view and conversation"],
  ["save", "save transcript to a file (/save [path])"],
  ["thinker", "show the configured thinker"],
];

export async function loadRegistry(commandsDir: string): Promise<Registry> {
  const commands = new Map<string, CommandDef>();
  for (const [name, description] of BUILTINS) {
    commands.set(name, { name, description, kind: "builtin" });
  }
  // /q and /exit alias quit
  commands.set("q", { name: "q", description: "alias for /quit", kind: "builtin" });
  commands.set("exit", { name: "exit", description: "alias for /quit", kind: "builtin" });

  try {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, basename, extname } = await import("node:path");
    for (const f of readdirSync(commandsDir)) {
      const ext = extname(f);
      if (ext !== ".md" && ext !== ".sh") continue;
      const name = basename(f, ext).toLowerCase();
      const path = join(commandsDir, f);
      if (ext === ".md") {
        const raw = readFileSync(path, "utf8");
        const lines = raw.split("\n");
        const description = lines[0].replace(/^#\s*/, "").trim() || "custom prompt command";
        commands.set(name, { name, description, kind: "prompt", path, template: lines.slice(1).join("\n").trim() });
      } else {
        let executable = false;
        try { executable = (statSync(path).mode & 0o111) !== 0; } catch {}
        if (!executable) continue;
        commands.set(name, { name, description: "custom shell command", kind: "exec", path });
      }
    }
  } catch {
    // no commands dir — builtins only
  }
  return { commands, dir: commandsDir };
}

/** Render a prompt template with {{input}} and {{history}}. */
export function renderTemplate(tpl: string, ctx: ChatContext): string {
  return tpl.split("{{input}}").join(ctx.args).split("{{history}}").join(ctx.historyText);
}

/** Run an exec command file. Returns stdout (capped). */
export async function runExecCommand(def: CommandDef, ctx: ChatContext): Promise<string> {
  const proc = Bun.spawn([def.path!, ...ctx.args.split(/\s+/).filter(Boolean)], {
    env: { ...process.env, LOOM_ARGS: ctx.args, LOOM_HISTORY: ctx.historyText },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let text = out.trim() || "(no output)";
  if (code !== 0 && err.trim()) text += `\n[stderr, exit ${code}] ${err.trim().slice(0, 500)}`;
  return text.slice(0, 8000);
}

export function helpText(reg: Registry): string {
  const rows: string[] = ["commands:"];
  for (const c of reg.commands.values()) {
    if (c.name === "q" || c.name === "exit") continue;
    const tag = c.kind === "prompt" ? " (prompt)" : c.kind === "exec" ? " (shell)" : "";
    rows.push(`  /${c.name}${tag} — ${c.description}`);
  }
  rows.push(`\ncustom commands live in ${reg.dir} — add <name>.md (prompt template) or <name>.sh (executable).`);
  return rows.join("\n");
}
