/* exec.ts — run a shell command with timeout, output caps, and spillover. */
import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

/** Bytes kept in-DB / handed to the thinker: head + tail. */
export const HEAD_KEEP = 8 * 1024;
export const TAIL_KEEP = 24 * 1024;

export interface ExecResult {
  code: number;
  timedOut: boolean;
  ms: number;
  head: string;        // capped text for DB + thinker
  outputHash: string;  // sha1 of the FULL output (spin detection)
  logPath: string | null;
  truncated: boolean;
}

export async function runExec(
  cmd: string,
  opts: { timeout_s?: number; cwd?: string; logDir?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const timeoutMs = (opts.timeout_s ?? 120) * 1000;
  const t0 = Date.now();
  const logDir = opts.logDir || join(process.env.LOOM_DATA_DIR || join(import.meta.dir, "..", "data"), "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `exec-${t0}-${Math.floor(Math.random() * 1e6)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = createWriteStream(logPath);
  const hash = createHash("sha1");
  let bytes = 0;
  let head = "";
  const tailChunks: Buffer[] = [];
  let tailBytes = 0;
  let truncated = false;

  const pump = async (stream: ReadableStream<Uint8Array> | null, readers: ReadableStreamDefaultReader<Uint8Array>[]) => {
    if (!stream) return;
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > HEAD_KEEP + TAIL_KEEP) truncated = true;
        hash.update(value);
        out.write(value);
        if (head.length < HEAD_KEEP) head += Buffer.from(value).toString("utf8").slice(0, HEAD_KEEP - head.length);
        tailChunks.push(Buffer.from(value));
        tailBytes += value.length;
        // keep exactly the last TAIL_KEEP bytes (a single chunk may exceed it)
        while (tailBytes > TAIL_KEEP) {
          const excess = tailBytes - TAIL_KEEP;
          const c = tailChunks[0];
          if (c.length <= excess) { tailChunks.shift(); tailBytes -= c.length; }
          else { tailChunks[0] = c.slice(excess); tailBytes -= excess; }
        }
      }
    } catch {
      // reader cancelled on timeout — the orphaned grandchild keeps the pipe
      // open, but we no longer wait on it
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  };

  let timedOut = false;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const killer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch {}
    for (const r of readers) { try { r.cancel(); } catch {} }
  }, timeoutMs);

  const [code] = await Promise.all([proc.exited, pump(proc.stdout, readers), pump(proc.stderr, readers)]);
  clearTimeout(killer);
  await new Promise<void>((res) => out.end(() => res()));

  const ms = Date.now() - t0;
  const tail = Buffer.concat(tailChunks).toString("utf8");
  const headText = head.length >= HEAD_KEEP && tail.length > 0
    ? head + `\n…(${bytes} bytes total, log: ${logPath})…\n` + tail
    : head + tail;

  return {
    code, timedOut, ms,
    head: headText,
    outputHash: hash.digest("hex").slice(0, 16),
    logPath,
    truncated,
  };
}
