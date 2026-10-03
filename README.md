# loom

A harness for **long thoughts in low-memory environments**. The user doesn't need instant feedback — they need models to *complete* thoughts and tasks without spinning in circles, on machines with <4GB of RAM.

Bun + SQLite, zero npm dependencies. No web UI (CLI-only by design — this is infrastructure).

## The thesis

Long agentic runs die three deaths: **context overflow** (the prompt grows until the model drowns), **spinning** (the same failed action retried forever), and **amnesia** (a crash wipes the thought). Loom answers each structurally, not with vibes:

1. **The durable thought lives in SQLite, not in RAM.** Goal, plan, ledger, step results — all persisted every turn. A killed worker resumes from the database, not from scratch.
2. **Workers are ephemeral.** Each reasoning turn spawns a fresh thinker process, feeds it a *bounded* context (16KB hard cap), captures one JSON action, and kills it. RAM is freed every turn by construction.
3. **Spinning is a detected condition, not a hope.** Every action is fingerprinted (whitespace/key-order/timeout-insensitive). Same fingerprint + byte-identical output three times → strike; three strikes → a replan prompt is injected; one more identical repeat → the job is parked as `blocked` with the evidence attached. Same action with *different* output is treated as learning, not looping.

## How it runs

```
loom submit "migrate the auth module to passkeys" --name passkeys
LOOM_THINKER="sh examples/thinker-openai.sh" loom work     # daemon
loom chat                     # Pi-style TUI chat with the thinker
loom board        # all jobs
loom log <id>     # the thought, oldest → newest
loom wait <id>    # block until done
loom outbox       # completion notices
```

The loop, per turn: build bounded context → think → execute exactly one action (`exec`, `read`, `write`, `note`, `finish`, `blocked`) → ledger → spin-check. `exec` runs with a timeout (kills the whole pipe, not just the parent), keeps 8KB head + 24KB tail in the DB, and spills the full log to disk. `write` is capped at 200KB. Nothing unbounded ever enters the context.

## The thinker protocol

The thinker is **any executable**: a model CLI, a script, a human-in-the-loop. It reads the context on stdin and prints one JSON object on stdout. Nothing is auto-configured — set `LOOM_THINKER` yourself:

```sh
# any OpenAI-compatible endpoint (see examples/thinker-openai.sh)
export LOOM_API_URL=https://your-host/v1 LOOM_API_KEY=... LOOM_MODEL=...
export LOOM_THINKER="sh examples/thinker-openai.sh"
```

`examples/thinker-fake.sh` is a deterministic stub for tests and dry runs.

## Memory discipline

- Context to the thinker: **16KB hard cap**, action protocol first (never clipped).
- Step output in DB: **32KB** (8 head + 24 tail); full logs spill to `data/logs/`.
- File reads capped at 32KB, writes at 200KB.
- Measured: 24MB of step output across 12 steps → **53MB RSS**, DB stays near-empty.
- `loom gc` prunes old logs and vacuums.

## Anti-spin, precisely

| Signal | Response |
|---|---|
| same fingerprint, new output | ok — it's learning; strikes decay |
| same fingerprint, identical output | strike (1, 2) + ledger warning |
| 3rd identical repeat | replan prompt injected, one last chance |
| identical repeat after replan | job `blocked`, evidence in outbox |
| thinker crashes / emits garbage 3x | job `blocked` |
| step budget (200) / wall clock (6h) hit | job `failed` |

## Crash recovery

The daemon heartbeats every turn. `loom work` reclaims any job whose heartbeat is older than 5 minutes, notes "resuming from persisted state" in the ledger, and continues — the spin detector rebuilds its state from the step trail.

## Project layout

- `src/db.ts` — schema + persistence helpers
- `src/spin.ts` — fingerprint + spin detector (pure)
- `src/context.ts` — bounded context builder
- `src/exec.ts` — timeout/cap/spill command runner
- `src/think.ts` — thinker stdio protocol
- `src/loop.ts` — the react loop + daemon + recovery
- `src/cli.ts` — the CLI
- `examples/` — fake (tests) + OpenAI-compatible thinkers
- `tests/` — 62 checks: spin vectors, budget caps, timeout kills, full loop incl. a spinner that gets parked, stale-heartbeat resume, RSS bounds

## `loom chat` — Pi-style minimal TUI

A full-screen terminal chat with the thinker. Alternate buffer, one-line input with history (Up/Down), tab-completion, PgUp/PgDn scrollback, `NO_COLOR` respected, terminal always restored on exit.

Every chat session is a loom job (`status: 'chat'` — the daemon ignores it), so the conversation persists to the ledger: `loom log <id>` replays it, and a markdown transcript auto-saves to `data/chats/`.

**Programmable slash commands** — drop files in `data/commands/` (or `$LOOM_COMMANDS_DIR`):

- `<name>.md` — prompt template. `{{input}}` is the text after the command, `{{history}}` the bounded transcript. First `# line` is the `/help` description.
- `<name>.sh` — executable. Args on argv, `$LOOM_ARGS` / `$LOOM_HISTORY` in env; stdout is shown in chat.

Builtins: `/help` `/quit` `/clear` `/save [path]` `/thinker`. See `examples/commands/` (`summarize.md`, `shout.sh`).

## Non-goals (v1)

No web UI, no multi-worker parallelism on one job, no model management (bring your own thinker — nothing is downloaded or configured for you).
