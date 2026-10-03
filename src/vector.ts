/* vector.ts — per-job vector memory for the forgetting problem.
   Everything worth remembering is embedded: step outputs, notes, the goal,
   the plan, finish/blocked summaries. Two attack paths:
   1. `recall` action — the thinker pulls relevant past chunks on demand.
   2. auto-augment — when the ledger tail truncates, the loop injects the
      most relevant older chunks back into the context.
   Two embedder tiers:
   - builtin (default): zero-dep hashed char-trigram vectors, 512-dim,
     L2-normalized. Deterministic, microseconds, no downloads.
   - ollama: POST {base}/api/embed when LOOM_EMBED_MODEL is set, for real
     semantic embeddings. Rows are tagged with embedder name; recall only
     ever compares rows from the same embedder.
   Vectors live as blobs in SQLite. A job caps at 200 steps, so brute-force
   cosine over the job's rows is trivial (<2MB) — no native deps needed. */
import { Database } from "bun:sqlite";

export const BUILTIN_DIM = 512;
const TEXT_CAP = 4096; // max bytes indexed per chunk

export interface Embedder {
  name: string;
  dim: number; // -1 when unknown until first embed (ollama)
  embed: (text: string) => Promise<Float32Array>;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Zero-dep embedder: hashed character trigrams, sqrt-scaled, L2-normalized. */
export function embedBuiltin(text: string): Float32Array {
  const v = new Float32Array(BUILTIN_DIM);
  const t = (" " + text.toLowerCase().replace(/\s+/g, " ") + " ").slice(0, 20000);
  for (let i = 0; i + 3 <= t.length; i++) v[fnv1a(t.slice(i, i + 3)) % BUILTIN_DIM] += 1;
  let norm = 0;
  for (let i = 0; i < BUILTIN_DIM; i++) { v[i] = Math.sqrt(v[i]); norm += v[i] * v[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < BUILTIN_DIM; i++) v[i] /= norm;
  return v;
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  if (n !== 1) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

async function embedOllama(text: string, model: string, base: string): Promise<Float32Array> {
  const r = await fetch(`${base}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text.slice(0, TEXT_CAP) }),
  });
  if (!r.ok) throw new Error(`embed failed: HTTP ${r.status}`);
  const d = (await r.json()) as { embeddings?: number[][] };
  if (!d.embeddings?.[0]) throw new Error("embed failed: no embeddings in response");
  return normalize(Float32Array.from(d.embeddings[0]));
}

/** Pick the embedder: Ollama when LOOM_EMBED_MODEL is set, else builtin. */
export function getEmbedder(): Embedder {
  const model = process.env.LOOM_EMBED_MODEL;
  if (model) {
    const base = (process.env.LOOM_EMBED_URL || "http://localhost:11434").replace(/\/$/, "");
    return { name: `ollama:${model}`, dim: -1, embed: (t) => embedOllama(t, model, base) };
  }
  return { name: "builtin-trigram-512", dim: BUILTIN_DIM, embed: async (t) => embedBuiltin(t) };
}

export function initVectors(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      embedder TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vectors_job ON vectors(job_id, embedder);
  `);
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array, dim: number): Float32Array {
  const buf = Buffer.from(b);
  return new Float32Array(buf.buffer, buf.byteOffset, dim);
}

/** Index one chunk of text for a job. Never throws (logs are the fallback). */
export async function indexChunk(
  db: Database, jobId: string, kind: string, ref: string, text: string, embedder: Embedder,
): Promise<boolean> {
  const t = text.slice(0, TEXT_CAP);
  if (!t.trim()) return false;
  try {
    const v = normalize(await embedder.embed(t));
    db.query(`INSERT INTO vectors (job_id, kind, ref, text, embedder, dim, vec, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jobId, kind, ref, t, embedder.name, v.length, toBlob(v), Date.now());
    return true;
  } catch {
    return false;
  }
}

export interface RecallHit { kind: string; ref: string; text: string; score: number; }

/** Top-k chunks for a query, cosine similarity, same-embedder rows only. */
export async function recall(
  db: Database, jobId: string, query: string, k: number, embedder: Embedder,
): Promise<RecallHit[]> {
  const q = query.slice(0, TEXT_CAP).trim();
  if (!q) return [];
  let qv: Float32Array;
  try { qv = normalize(await embedder.embed(q)); } catch { return []; }
  const rows = db.query(`SELECT kind, ref, text, dim, vec FROM vectors WHERE job_id = ? AND embedder = ?`)
    .all(jobId, embedder.name) as Array<{ kind: string; ref: string; text: string; dim: number; vec: Uint8Array }>;
  const scored: RecallHit[] = [];
  for (const r of rows) {
    if (r.dim !== qv.length) continue;
    const v = fromBlob(r.vec, r.dim);
    let dot = 0;
    for (let i = 0; i < qv.length; i++) dot += qv[i] * v[i];
    scored.push({ kind: r.kind, ref: r.ref, text: r.text, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(k, 8)));
}

/** How many vectors a job has (for status/board). */
export function vectorCount(db: Database, jobId: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM vectors WHERE job_id = ?`).get(jobId) as { n: number }).n;
}
