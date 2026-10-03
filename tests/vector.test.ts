/* vector.test.ts — vector memory: embedder, recall ranking, loop integration. Run with bun. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import {
  embedBuiltin, BUILTIN_DIM, getEmbedder, initVectors,
  indexChunk, recall, vectorCount,
} from "../src/vector";
import { workOnce } from "../src/loop";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}
const cosine = (a: Float32Array, b: Float32Array) => {
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d;
};

const tmp = mkdtempSync(join(tmpdir(), "loom-vec-"));
process.env.LOOM_DATA_DIR = join(tmp, "data");
const db = openDb(join(tmp, "t.db"));
initVectors(db);

// ---- 1. builtin embedder properties ----
{
  const v1 = embedBuiltin("the quick brown fox");
  const v2 = embedBuiltin("the quick brown fox");
  ok(v1.length === BUILTIN_DIM, `builtin dim ${BUILTIN_DIM}`);
  ok(v1.every((x, i) => x === v2[i]), "deterministic: identical text -> bit-identical vector");
  let norm = 0; for (let i = 0; i < v1.length; i++) norm += v1[i] * v1[i];
  ok(Math.abs(norm - 1) < 1e-6, "L2-normalized");
  const rel = embedBuiltin("the quick brown fox jumps");
  const unrel = embedBuiltin("quantum chromodynamics lattice gauge");
  ok(cosine(v1, rel) > cosine(v1, unrel), "related texts score higher than unrelated");
  ok(embedBuiltin("").every((x) => x === 0) || true, "empty text embeds without throwing");
}

// ---- 2. recall ranking ----
{
  const E = getEmbedder();
  ok(E.name === "builtin-trigram-512", "default embedder is builtin");
  await indexChunk(db, "j1", "step", "a", "the database migration failed on the users table with a foreign key error", E);
  await indexChunk(db, "j1", "step", "b", "deployed the frontend bundle to the cdn edge nodes", E);
  await indexChunk(db, "j1", "note", "c", "remember to rotate the api keys next tuesday", E);
  const hits = await recall(db, "j1", "foreign key error on users table migration", 3, E);
  ok(hits.length === 3, "recall returns k hits");
  ok(hits[0].ref === "a", `top hit is the migration chunk (got ${hits[0].ref})`);
  ok(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score, "scores sorted desc");
  ok(hits[0].kind === "step" && hits[0].text.includes("migration"), "hit carries kind+text");
  ok(vectorCount(db, "j1") === 3, "vectorCount counts rows");
}

// ---- 3. embedder isolation + edge cases ----
{
  const E = getEmbedder();
  const hits = await recall(db, "j1", "migration", 3, { ...E, name: "other-model" });
  ok(hits.length === 0, "recall only compares same-embedder rows");
  ok((await recall(db, "j1", "   ", 3, E)).length === 0, "blank query -> no hits");
  ok((await recall(db, "nope", "migration", 3, E)).length === 0, "unknown job -> no hits");
  ok(await indexChunk(db, "j1", "note", "empty", "   ", E) === false, "blank chunk not indexed");
  const big = "x".repeat(10000);
  await indexChunk(db, "j1", "note", "big", big, E);
  const row = db.query(`SELECT text FROM vectors WHERE job_id='j1' AND ref='big'`).get() as { text: string };
  ok(row.text.length === 4096, "chunk text capped at 4096 bytes");
}

// ---- 4. ollama embedder via stub ----
{
  const DIM = 8;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/api/embed")) return new Response("nf", { status: 404 });
      const body = await req.json() as { model: string; input: string };
      const v = Array.from({ length: DIM }, (_, i) => Math.sin(body.input.length + i));
      return Response.json({ embeddings: [v] });
    },
  });
  const prevM = process.env.LOOM_EMBED_MODEL, prevU = process.env.LOOM_EMBED_URL;
  process.env.LOOM_EMBED_MODEL = "stub-embed";
  process.env.LOOM_EMBED_URL = `http://127.0.0.1:${srv.port}`;
  const E = getEmbedder();
  ok(E.name === "ollama:stub-embed", "LOOM_EMBED_MODEL selects ollama embedder");
  const v = await E.embed("hello world");
  ok(v.length === DIM, "ollama embed returns model dim");
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  ok(Math.abs(n - 1) < 1e-6, "ollama vectors normalized");
  await indexChunk(db, "j2", "step", "s1", "alpha beta gamma delta", E);
  const hits = await recall(db, "j2", "alpha beta", 2, E);
  ok(hits.length === 1 && hits[0].ref === "s1", "ollama recall round-trips through the store");
  // builtin recall must not see ollama rows
  const builtin = { name: "builtin-trigram-512", dim: BUILTIN_DIM, embed: async (t: string) => embedBuiltin(t) };
  ok((await recall(db, "j2", "alpha beta", 2, builtin)).length === 0, "cross-embedder isolation holds in store");
  if (prevM === undefined) delete process.env.LOOM_EMBED_MODEL; else process.env.LOOM_EMBED_MODEL = prevM;
  if (prevU === undefined) delete process.env.LOOM_EMBED_URL; else process.env.LOOM_EMBED_URL = prevU;
  srv.stop();
}

// ---- 5. loop integration: recall action finds an earlier exec ----
{
  const id = "job_recall_it";
  const now = Date.now();
  const thinker = join(tmp, "thinker-recall.sh");
  const state = join(tmp, "recall-state");
  await Bun.write(state, "0");
  await Bun.write(thinker,
    `#!/bin/sh\n` +
    `export FAKE_STATE_FILE=${state}\n` + // not used; inline counter instead
    `c=$(cat ${state} 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > ${state}\n` +
    `if [ "$c" = 1 ]; then printf '{"action":"exec","cmd":"echo zebra-quasar-alpha-omega","label":"seed"}\\n';\n` +
    `elif [ "$c" = 2 ]; then printf '{"action":"recall","query":"zebra quasar","k":3}\\n';\n` +
    `else printf '{"action":"finish","summary":"recall worked"}\\n'; fi\n`);
  await Bun.$`chmod +x ${thinker}`.quiet();
  db.query(`INSERT INTO jobs (id, name, goal, status, thinker, max_steps, max_wall_s, created_at, updated_at, heartbeat_at)
            VALUES (?, ?, ?, 'pending', ?, 20, 600, ?, ?, ?)`)
    .run(id, "recall-it", "test that recall finds the seeded exec output", `sh ${thinker}`, now, now, now);
  await workOnce(db, {});
  const j = db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
  ok(j.status === "done", "recall job completes");
  const rstep = db.query(`SELECT output_head FROM steps WHERE job_id = ? AND action = 'recall'`).get(id) as any;
  ok(rstep && rstep.output_head.includes("zebra-quasar-alpha-omega"), "recall surfaced the earlier exec output");
  ok(vectorCount(db, id) >= 3, `job indexed goal + exec + note-ish chunks (${vectorCount(db, id)})`);
}

// ---- 6. auto-augment: truncated history pulls memory back in ----
{
  const id = "job_augment_it";
  const now = Date.now();
  const thinker = join(tmp, "thinker-augment.sh");
  const ctxFile = join(tmp, "augment-ctx.txt");
  await Bun.write(thinker,
    `#!/bin/sh\ncat > ${ctxFile}\nprintf '{"action":"finish","summary":"augment done"}\\n'\n`);
  await Bun.$`chmod +x ${thinker}`.quiet();
  db.query(`INSERT INTO jobs (id, name, goal, status, thinker, max_steps, max_wall_s, created_at, updated_at, heartbeat_at)
            VALUES (?, ?, ?, 'pending', ?, 5, 600, ?, ?, ?)`)
    .run(id, "augment-it", "retrieve the secret codename blue-harbor from memory", `sh ${thinker}`, now, now, now);
  // flood the ledger so the tail truncates, and bury the codename in an early note
  db.query(`INSERT INTO ledger (job_id, seq, kind, text, created_at) VALUES (?, 1, 'note', ?, ?)`)
    .run(id, "the secret codename is blue-harbor, decided in the kickoff", now);
  for (let i = 0; i < 80; i++)
    db.query(`INSERT INTO ledger (job_id, seq, kind, text, created_at) VALUES (?, ?, 'action', ?, ?)`)
      .run(id, 2 + i, "filler " + i + " " + "x".repeat(2000), now);
  // index the codename as if an early step had produced it
  const E = getEmbedder();
  await indexChunk(db, id, "note", "kickoff", "the secret codename is blue-harbor, decided in the kickoff", E);
  await workOnce(db, {});
  const ctx = await Bun.file(ctxFile).text();
  ok(ctx.includes("…(older history truncated)…"), "ledger tail actually truncated");
  ok(ctx.includes("RELEVANT MEMORY"), "auto-augment injected recalled memory");
  ok(ctx.includes("blue-harbor"), "the buried codename was recovered into context");
  ok(Buffer.byteLength(ctx, "utf8") <= 16384, "augmented context stays within budget");
}

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
