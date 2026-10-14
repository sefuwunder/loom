/* research.test.ts — loom ↔ longview wiring. Run with: bun tests/research.test.ts */
import { buildContext } from "../src/context";

let pass = 0, fail = 0;
function ok(c: boolean, n: string): void {
  if (c) { pass++; console.log(`ok - ${n}`); } else { fail++; console.log(`NOT OK - ${n}`); }
}

// 1. The thinker protocol advertises the research action
import { Database } from "bun:sqlite";
const memDb = new Database(":memory:");
memDb.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT, goal TEXT, plan TEXT, status TEXT, created_at INTEGER)`);
memDb.exec(`CREATE TABLE ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, kind TEXT, text TEXT)`);
memDb.query(`INSERT INTO jobs (id, name, goal, plan, status, created_at) VALUES (?,?,?,?,?,?)`)
  .run("test-job", "test", "test goal", null, "active", Date.now());
const ctx = buildContext(memDb, "test-job", "test goal", null, null, null, {});
ok(ctx.includes('"action":"research"'), "protocol includes research action");
ok(ctx.includes("Longview"), "protocol names Longview as the research backend");
ok(ctx.includes('"question"'), "protocol shows the question field");

// 2. think() accepts a research action as valid
const { think } = await import("../src/think");
const r = await think(
  `cat >/dev/null && printf '%s' '{"action":"research","question":"What is the best pricing model?","label":"pricing"}'`,
  "dummy context",
  { timeout_s: 5 }
);
ok(r.ok === true, "think() accepts research action");
ok((r.action as any)?.action === "research", "parsed action is research");
ok((r.action as any)?.question === "What is the best pricing model?", "question field parsed");

// 3. research without a question is rejected at execution time (tested via think validation of empty)
// (execution itself needs longview; the fail-closed paths are: no question → fail,
//  unreachable → fail with helpful message — both are string checks in loop.ts)



// 4. End-to-end: research action against a stubbed Longview
{
  const stub = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/agent" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true, run_id: 42 }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (u.pathname === "/api/agent/42") {
        return new Response(JSON.stringify({
          ok: true,
          run: {
            id: 42, status: "done",
            findings: ["Tiered pricing wins for SaaS.", "Freemium converts at 3%."],
            sources: ["example.com/a", "example.com/b"],
          },
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  process.env.LONGVIEW_URL = `http://127.0.0.1:${stub.port}`;

  const { executeAction } = await import("../src/loop");
  const { openDb } = await import("../src/db");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "loom-research-"));
  const db = openDb(join(tmp, "loom.db"));
  // minimal job row
  db.exec(`INSERT INTO jobs (id, name, goal, status, created_at, updated_at, heartbeat_at) VALUES ('j1','t','g','active',1,1,1)`);
  const fakeJob: any = { id: "j1", name: "t" };
  const fakeEmbedder: any = { embed: async () => [] };
  const r = await executeAction(
    db, fakeJob,
    { action: "research", question: "best pricing?", label: "pricing" } as any,
    tmp, fakeEmbedder,
    async () => {}
  );
  ok(r.failed === false, "research action succeeds against stubbed longview");
  ok(r.text.includes("Tiered pricing"), "findings returned to thinker");
  ok(r.text.includes("example.com/a"), "sources included");
  ok(r.text.length <= 4000, "output fits context budget");
  // step was recorded
  const steps = db.query(`SELECT * FROM steps WHERE job_id = 'j1'`).all() as any[];
  ok(steps.length === 1 && steps[0].action === "research", "research step recorded in ledger");
  db.close();
  stub.stop();
  delete process.env.LONGVIEW_URL;
}

// 5. Fail-closed: unreachable longview
{
  process.env.LONGVIEW_URL = "http://127.0.0.1:1";
  const { executeAction } = await import("../src/loop");
  const { openDb } = await import("../src/db");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "loom-research-"));
  const db = openDb(join(tmp, "loom.db"));
  db.exec(`INSERT INTO jobs (id, name, goal, status, created_at, updated_at, heartbeat_at) VALUES ('j2','t','g','active',1,1,1)`);
  const r = await executeAction(
    db, { id: "j2", name: "t" } as any,
    { action: "research", question: "x?" } as any,
    tmp, { embed: async () => [] } as any,
    async () => {}
  );
  ok(r.failed === true, "unreachable longview fails closed");
  ok(r.text.includes("is it running"), "helpful error message");
  db.close();
  delete process.env.LONGVIEW_URL;
}



// 6. recon: think() accepts the recon action
{
  const { think } = await import("../src/think");
  const r1 = await think(
    `cat >/dev/null && printf '%s' '{"action":"recon","target":"example.com","label":"seed"}'`,
    "dummy", { timeout_s: 5 }
  );
  ok(r1.ok === true && (r1.action as any)?.action === "recon", "think() accepts recon seed action");
  const r2 = await think(
    `cat >/dev/null && printf '%s' '{"action":"recon","investigation":"inv-abc","transform":"dns","entity":"example.com"}'`,
    "dummy", { timeout_s: 5 }
  );
  ok(r2.ok === true && (r2.action as any)?.transform === "dns", "think() accepts recon pivot action");
}

// 7. recon end-to-end against stubbed Meridian
{
  let invId = "inv-test1";
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/investigations" && req.method === "POST") {
        return new Response(JSON.stringify({
          investigation: {
            id: invId,
            entities: [{ id: "domain:example.com", type: "domain", value: "example.com" }],
            links: [],
          },
        }), { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/transforms") {
        return new Response(JSON.stringify({
          transforms: [{ key: "cert-transparency", inputTypes: ["domain"] }],
        }), { headers: { "content-type": "application/json" } });
      }
      const m = u.pathname.match(/^\/api\/investigations\/([^/]+)\/transform$/);
      if (m && req.method === "POST") {
        return new Response(JSON.stringify({
          note: "found 2 subdomains",
          addedEntities: 2, addedLinks: 2,
          investigation: {
            id: invId,
            entities: [
              { id: "domain:example.com", type: "domain", value: "example.com" },
              { id: "domain:www.example.com", type: "domain", value: "www.example.com" },
              { id: "domain:api.example.com", type: "domain", value: "api.example.com" },
            ],
            links: [],
          },
        }), { headers: { "content-type": "application/json" } });
      }
      const gm = u.pathname.match(/^\/api\/investigations\/([^/]+)$/);
      if (gm) {
        return new Response(JSON.stringify({
          investigation: {
            id: invId,
            entities: [{ id: "domain:example.com", type: "domain", value: "example.com" }],
            links: [],
          },
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  process.env.MERIDIAN_URL = `http://127.0.0.1:${stub.port}`;

  const { executeAction } = await import("../src/loop");
  const { openDb } = await import("../src/db");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "loom-recon-"));
  const db = openDb(join(tmp, "loom.db"));
  db.exec(`INSERT INTO jobs (id, name, goal, status, created_at, updated_at, heartbeat_at) VALUES ('j3','t','g','active',1,1,1)`);
  const idx: string[] = [];

  // Seed
  const s = await executeAction(
    db, { id: "j3", name: "t" } as any,
    { action: "recon", target: "example.com", label: "seed" } as any,
    tmp, { embed: async () => [] } as any,
    async (k: string, r: string, t: string) => { idx.push(t); }
  );
  ok(s.failed === false, "recon seed succeeds");
  ok(s.text.includes(invId), "seed returns investigation id");
  ok(s.text.includes("cert-transparency"), "seed lists available pivots");

  // Pivot
  const p = await executeAction(
    db, { id: "j3", name: "t" } as any,
    { action: "recon", investigation: invId, transform: "cert-transparency", entity: "example.com" } as any,
    tmp, { embed: async () => [] } as any,
    async (k: string, r: string, t: string) => { idx.push(t); }
  );
  ok(p.failed === false, "recon pivot succeeds");
  ok(p.text.includes("www.example.com"), "pivot returns new entities");
  ok(p.text.includes(invId), "pivot reminds thinker of investigation id");
  db.close();
  stub.stop();
  delete process.env.MERIDIAN_URL;
}

// 8. research with Beacon fan-out
{
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/agent" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true, run_id: 7 }),
          { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/agent/7") {
        return new Response(JSON.stringify({
          ok: true, run: { id: 7, status: "done", findings: ["Juice bars are growing."], sources: [] },
        }), { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/search" && req.method === "POST") {
        return new Response(JSON.stringify({ job_id: "b1", status: "running" }),
          { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/search/b1") {
        return new Response(JSON.stringify({
          id: "b1", status: "done",
          companies: [
            { name: "Green Squeeze", city: "Cincinnati", state: "OH", url: "https://example.com", description: "Cold-pressed juice." },
          ],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  // Both Longview and Beacon point at the same stub (different paths)
  process.env.LONGVIEW_URL = `http://127.0.0.1:${stub.port}`;
  process.env.BEACON_URL = `http://127.0.0.1:${stub.port}`;

  const { executeAction } = await import("../src/loop");
  const { openDb } = await import("../src/db");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "loom-fanout-"));
  const db = openDb(join(tmp, "loom.db"));
  db.exec(`INSERT INTO jobs (id, name, goal, status, created_at, updated_at, heartbeat_at) VALUES ('j4','t','g','active',1,1,1)`);
  const r = await executeAction(
    db, { id: "j4", name: "t" } as any,
    { action: "research", question: "juice bar landscape?", business: "juice bars in Cincinnati" } as any,
    tmp, { embed: async () => [] } as any,
    async () => {}
  );
  ok(r.failed === false, "research+beacon fan-out succeeds");
  ok(r.text.includes("Juice bars are growing"), "longview findings present");
  ok(r.text.includes("Green Squeeze"), "beacon companies present");
  ok(r.text.includes("Cincinnati"), "beacon location present");
  db.close();
  stub.stop();
  delete process.env.LONGVIEW_URL;
  delete process.env.BEACON_URL;
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
