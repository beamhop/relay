/**
 * beamhop load benchmarks. Each scenario starts its own server process (see lib/server.ts) on a throwaway data dir
 * (postgres: the `load_tests` database, emptied first) and prints a markdown table.
 *
 *   bun e2e/load/bench.ts [--db sqlite,postgres] [--only write,fanout,query,count,neg,conns,blossom]
 *                         [--events 20000] [--corpus 1000000] [--subscribers 2000] [--conns 5000] [--pg-url URL]
 *
 * Numbers are indicative: client and server share the machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Event } from "nostr-tools";
// nostr-tools ships a negentropy client but doesn't export the subpath
// @ts-ignore
import { Negentropy, NegentropyStorageVector } from "../node_modules/nostr-tools/lib/esm/nip77.js";
import { blossomAuth, sha256 } from "../harness/client";
import { connectMany, LoadConn } from "./lib/client";
import { AUTHORS, authorPubkey, HASHTAGS, seedEvent, eventId } from "./lib/seed";
import { DEFAULT_PG_URL, resetPostgres, seed, ServerProc, type DbKind } from "./lib/server";
import { makeNotes, newSigner } from "./lib/sign";
import { mb, pool, round, Samples, table } from "./lib/stats";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: "sqlite,postgres" },
    only: { type: "string", default: "write,fanout,query,count,neg,conns,blossom" },
    events: { type: "string", default: "20000" },
    corpus: { type: "string", default: "1000000" },
    subscribers: { type: "string", default: "2000" },
    conns: { type: "string", default: "5000" },
    "pg-url": { type: "string", default: DEFAULT_PG_URL },
    /** keep the seeded corpus here and reuse it on later runs (sqlite: the database; postgres: just its base time) */
    "corpus-dir": { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});
const dbs = args.db!.split(",") as DbKind[];
const only = new Set(args.only!.split(","));
const pgUrl = args["pg-url"]!;

async function server(db: DbKind, opts: { verifyWorkers?: number; statsMs?: number; dir?: string; env?: Record<string, string> } = {}) {
  if (db === "postgres" && !opts.dir) await resetPostgres(pgUrl);
  const srv = await ServerProc.create({ db, pgUrl, quiet: !args.verbose, ...opts });
  await srv.start();
  return srv;
}

const out: string[] = [];
function report(title: string, rows: Record<string, unknown>[]) {
  const s = `\n### ${title}\n\n${table(rows)}\n`;
  out.push(s);
  console.log(s);
}

// ---------------------------------------------------------------- EVENT write throughput / OK latency

/**
 * `conns` connections publish pre-signed events, each keeping `window` EVENTs awaiting their OK (a pipelining
 * client). Reports accepted events/s and OK latency.
 */
async function writeRun(srv: ServerProc, events: Event[], conns: number, window: number) {
  const { conns: cs } = await connectMany(srv.ws, conns);
  const lat = new Samples();
  let ok = 0;
  let failed = 0;
  const reasons = new Map<string, number>();
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    cs.map(async (c) => {
      await Promise.all(
        Array.from({ length: window }, async () => {
          while (next < events.length) {
            const r = await c.publish(events[next++]);
            lat.add(r.ms);
            if (r.ok) ok++;
            else {
              failed++;
              reasons.set(r.msg, (reasons.get(r.msg) ?? 0) + 1);
            }
          }
        }),
      );
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  for (const c of cs) c.close();
  return { conns, window, events: events.length, ok, failed, "ev/s": Math.round(ok / secs), ...pre(lat), reasons: [...reasons].map(([m, n]) => `${m}×${n}`).join("; ") };
}
const pre = (s: Samples) => {
  const x = s.summary();
  return { "p50 ms": x.p50, "p99 ms": x.p99, "max ms": x.max };
};

async function benchWrite(db: DbKind) {
  const n = Number(args.events);
  const signers = Array.from({ length: 200 }, newSigner);
  const rows: Record<string, unknown>[] = [];
  for (const verifyWorkers of [0, 4]) {
    const srv = await server(db, { verifyWorkers });
    try {
      // sequential baseline (one connection, one EVENT at a time)
      const base = await makeNotes(500, signers);
      rows.push({ verifyWorkers, ...(await writeRun(srv, base, 1, 1)) });
      for (const [conns, window] of [
        [10, 10],
        [50, 20],
        [200, 5],
      ]) {
        const evs = await makeNotes(n, signers);
        rows.push({ verifyWorkers, ...(await writeRun(srv, evs, conns, window)) });
      }
    } finally {
      await srv.stop();
      srv.cleanup();
    }
  }
  report(`${db}: EVENT write throughput`, rows);
}

// ---------------------------------------------------------------- live fan-out

async function benchFanout(db: DbKind) {
  const rows: Record<string, unknown>[] = [];
  const srv = await server(db);
  try {
    for (const subscribers of [500, Number(args.subscribers)]) {
      const { conns: subs, failed } = await connectMany(srv.ws, subscribers);
      const lat = new Samples();
      let received = 0;
      const sentAt = new Map<string, number>();
      await Promise.all(
        subs.map((c, i) =>
          c.req(`live${i}`, [{ kinds: [1], "#t": ["fanout"], limit: 0 }], {
            live: (ev) => {
              received++;
              const t = sentAt.get(ev.id);
              if (t !== undefined) lat.add(performance.now() - t);
            },
          }),
        ),
      );
      const pub = await LoadConn.connect(srv.ws);
      const n = 200;
      const evs = await makeNotes(n, [newSigner()], { tags: () => [["t", "fanout"]] });
      const t0 = performance.now();
      // 100 events/s
      for (const ev of evs) {
        sentAt.set(ev.id, performance.now());
        void pub.publish(ev);
        await Bun.sleep(10);
      }
      const expected = n * subs.length;
      const deadline = Date.now() + 30_000;
      while (received < expected && Date.now() < deadline) await Bun.sleep(50);
      const secs = (performance.now() - t0) / 1000;
      rows.push({
        subscribers: subs.length,
        "connect failed": failed,
        events: n,
        delivered: received,
        "delivered %": round((100 * received) / expected, 2),
        "deliveries/s": Math.round(received / secs),
        ...pre(lat),
      });
      pub.close();
      for (const c of subs) c.close();
      await Bun.sleep(500);
    }
  } finally {
    await srv.stop();
    srv.cleanup();
  }
  report(`${db}: live fan-out (kind 1 #t filter, 100 ev/s)`, rows);
}

/** A connection authenticated as the relay owner (staff skip the per-address read budgets). */
async function staffConn(srv: ServerProc): Promise<LoadConn> {
  const c = await LoadConn.connect(srv.ws);
  if (!(await c.auth(srv.ownerSk, srv.ws))) throw new Error("owner AUTH failed");
  return c;
}

// ---------------------------------------------------------------- historical queries on a large corpus

const corpusCache = new Map<DbKind, { srv: ServerProc; base: number }>();

/** One seeded server per backend, shared by query / count / neg. */
async function corpus(db: DbKind) {
  let c = corpusCache.get(db);
  if (c) return c;
  const dir = args["corpus-dir"] ? join(args["corpus-dir"], db) : undefined;
  const baseFile = dir ? join(dir, "base.txt") : undefined;
  const reuse = !!baseFile && existsSync(baseFile);
  if (dir) mkdirSync(dir, { recursive: true });
  if (db === "postgres" && !reuse) await resetPostgres(pgUrl);
  const srv = await ServerProc.create({ db, pgUrl, quiet: !args.verbose, dir });
  let base: number;
  if (reuse) base = Number(readFileSync(baseFile!, "utf8"));
  else {
    // migrate (and relax limits) on a first start, then seed with the server stopped
    await srv.start();
    await srv.stop();
    base = Math.floor(Date.now() / 1000);
    const n = Number(args.corpus);
    const ms = await seed(srv, n, base);
    console.log(`seeded ${n} events (${db}) in ${Math.round(ms / 1000)} s`);
    if (baseFile) writeFileSync(baseFile, String(base));
  }
  await srv.start(120_000);
  if (db === "postgres") {
    // planner statistics after a bulk load (autovacuum would get there eventually)
    const { psql } = await import("./lib/server");
    await psql(pgUrl, "ANALYZE");
  }
  c = { srv, base };
  corpusCache.set(db, c);
  return c;
}

const heavy = authorPubkey(0);
const light = authorPubkey(AUTHORS - 1);
const QUERIES: { name: string; filter: Record<string, unknown> }[] = [
  { name: "global feed kinds:[1] limit 50", filter: { kinds: [1], limit: 50 } },
  { name: "heavy author kinds:[1] limit 50", filter: { authors: [heavy], kinds: [1], limit: 50 } },
  { name: "light author kinds:[1] limit 50", filter: { authors: [light], kinds: [1], limit: 50 } },
  { name: "follow list 300 authors kinds:[1,6] limit 100", filter: { authors: Array.from({ length: 300 }, (_, i) => authorPubkey(i * 6)), kinds: [1, 6], limit: 100 } },
  { name: "follow list 300 light authors kinds:[1,6] limit 100", filter: { authors: Array.from({ length: 300 }, (_, i) => authorPubkey(AUTHORS - 300 + i)), kinds: [1, 6], limit: 100 } },
  { name: "follow list 1000 authors limit 100, until 200d ago", filter: { authors: Array.from({ length: 1000 }, (_, i) => authorPubkey(i * 2)), limit: 100, until: 0 } },
  { name: "follow list 40 authors kinds:[1,6] limit 100", filter: { authors: Array.from({ length: 40 }, (_, i) => authorPubkey(i * 50)), kinds: [1, 6], limit: 100 } },
  { name: "#p mentions of heavy author kinds:[1,7] limit 100", filter: { "#p": [heavy], kinds: [1, 7], limit: 100 } },
  { name: "#e replies/reactions to one event", filter: { "#e": [eventId(10)], limit: 500 } },
  { name: "#t hashtag limit 50", filter: { kinds: [1], "#t": [HASHTAGS[3]], limit: 50 } },
  { name: "#t 5 hashtags limit 50", filter: { "#t": HASHTAGS.slice(10, 15), limit: 50 } },
  { name: "since/until 1 day window kinds:[1] limit 100", filter: { kinds: [1], since: 0, until: 0, limit: 100 } },
  { name: "until 300d ago limit 100 (deep page)", filter: { until: 0, limit: 100 } },
  { name: "search common word limit 50", filter: { kinds: [1], search: "coffee", limit: 50 } },
  { name: "search rare word limit 50", filter: { search: "rareword", limit: 50 } },
  { name: "search 2 words limit 50", filter: { search: "nostr relay", limit: 50 } },
  { name: "ids lookup x20", filter: { ids: Array.from({ length: 20 }, (_, i) => eventId(i * 997)) } },
];

function resolveTimes(filter: Record<string, unknown>, base: number, name: string): Record<string, unknown> {
  const f = { ...filter };
  if (name.startsWith("since/until")) {
    f.since = base - 100 * 86_400;
    f.until = base - 99 * 86_400;
  }
  if (name.startsWith("until 300d")) f.until = base - 300 * 86_400;
  if (name.includes("until 200d")) f.until = base - 200 * 86_400;
  return f;
}

async function benchQuery(db: DbKind) {
  const { srv, base } = await corpus(db);
  const c = await staffConn(srv);
  const rows: Record<string, unknown>[] = [];
  let sid = 0;
  for (const q of QUERIES) {
    const f = resolveTimes(q.filter, base, q.name);
    const s = new Samples();
    let n = 0;
    let closed: string | undefined;
    // first run cold-ish, then 15 timed
    await c.req(`w${sid++}`, [f]);
    for (let i = 0; i < 15; i++) {
      const r = await c.req(`q${sid++}`, [f]);
      s.add(r.ms);
      n = r.n;
      closed ??= r.closed;
    }
    rows.push({ query: q.name, results: n, ...pre(s), ...(closed ? { closed } : {}) });
  }
  // concurrent mixed load: 50 clients × 40 queries (anonymous: the per-address budgets apply)
  const { conns } = await connectMany(srv.ws, 50);
  const mix = new Samples();
  const t0 = performance.now();
  await pool(conns, 50, async (cc, ci) => {
    for (let i = 0; i < 40; i++) {
      const q = QUERIES[(ci + i) % QUERIES.length];
      const r = await cc.req(`m${ci}_${i}`, [resolveTimes(q.filter, base, q.name)]);
      mix.add(r.ms);
    }
  });
  const secs = (performance.now() - t0) / 1000;
  rows.push({ query: "MIXED 50 clients concurrently", results: `${Math.round(mix.count / secs)} REQ/s`, ...pre(mix) });
  for (const cc of conns) cc.close();
  c.close();
  report(`${db}: historical REQ → EOSE on ${Number(args.corpus).toLocaleString("en-US")} events`, rows);

  // query plans (store SQL for the same filters)
  const plan = Bun.spawn([process.execPath, `${import.meta.dir}/server-proc.ts`], {
    cwd: srv.dir,
    env: srv.env({ LOAD_EXPLAIN: JSON.stringify(QUERIES.map((q) => ({ name: q.name, filter: resolveTimes(q.filter, base, q.name) }))) }),
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(plan.stdout).text();
  await plan.exited;
  const plans = text
    .split("\n")
    .filter((l) => l.startsWith("PLAN "))
    .map((l) => JSON.parse(l.slice(5)) as { name: string; plan: string[] });
  const pout = plans.map((p) => `-- ${p.name}\n${p.plan.join("\n")}`).join("\n\n");
  out.push(`\n<details><summary>${db} query plans</summary>\n\n\`\`\`\n${pout}\n\`\`\`\n</details>\n`);
  if (args.verbose) console.log(pout);
}

// ---------------------------------------------------------------- COUNT

async function benchCount(db: DbKind) {
  const { srv } = await corpus(db);
  const c = await staffConn(srv);
  const rows: Record<string, unknown>[] = [];
  const counts: { name: string; filter: Record<string, unknown> }[] = [
    { name: "all events {}", filter: {} },
    { name: "kinds:[1]", filter: { kinds: [1] } },
    { name: "kinds:[7] #p heavy author (followers' reactions)", filter: { kinds: [7], "#p": [heavy] } },
    { name: "authors heavy", filter: { authors: [heavy] } },
    { name: "#t hashtag", filter: { "#t": [HASHTAGS[0]] } },
    { name: "#e one event (reactions count)", filter: { "#e": [eventId(10)] } },
    { name: "search common word", filter: { search: "coffee" } },
  ];
  let sid = 0;
  for (const q of counts) {
    const s = new Samples();
    let result: unknown;
    for (let i = 0; i < 5; i++) {
      const r = await c.request(["COUNT", `c${sid}`, q.filter], `c${sid++}`, ["COUNT"]);
      s.add(r.ms);
      result = r.f[0] === "COUNT" ? (r.f[2] as { count: number }).count : `CLOSED ${r.f[2]}`;
    }
    rows.push({ count: q.name, result, ...pre(s) });
  }
  c.close();
  report(`${db}: COUNT on ${Number(args.corpus).toLocaleString("en-US")} events`, rows);
}

// ---------------------------------------------------------------- negentropy

async function benchNeg(db: DbKind) {
  const { srv, base } = await corpus(db);
  const c = await staffConn(srv);
  const rows: Record<string, unknown>[] = [];
  const n = Number(args.corpus);
  // local copies of the corpus for client-side sets (the seeded events are deterministic)
  const all = Array.from({ length: n }, (_, i) => seedEvent(i, base));
  const cases: { name: string; filter: Record<string, unknown>; local: (e: (typeof all)[number], i: number) => boolean }[] = [
    { name: "heavy author, empty client", filter: { authors: [heavy] }, local: () => false },
    { name: "heavy author, client has 99%", filter: { authors: [heavy] }, local: (e, i) => e.pubkey === heavy && i % 100 !== 0 },
    { name: "kinds:[7], client has 99%", filter: { kinds: [7] }, local: (e, i) => e.kind === 7 && i % 100 !== 0 },
    { name: "kinds:[1] (> 500k item cap?)", filter: { kinds: [1] }, local: (e, i) => e.kind === 1 && i % 100 !== 0 },
  ];
  let sid = 0;
  for (const k of cases) {
    const storage = new NegentropyStorageVector();
    let localN = 0;
    all.forEach((e, i) => {
      if (k.local(e, i)) {
        storage.insert(e.created_at, e.id);
        localN++;
      }
    });
    storage.seal();
    const neg = new Negentropy(storage, 60_000);
    const sub = `neg${sid++}`;
    const t0 = performance.now();
    let rounds = 0;
    let need = 0;
    let bytes = 0;
    let err: string | undefined;
    let msg = ["NEG-OPEN", sub, k.filter, await neg.initiate()];
    for (;;) {
      const r = await c.request(msg, sub, ["NEG-MSG", "NEG-ERR"]);
      if (r.f[0] !== "NEG-MSG") {
        err = String(r.f[2]);
        break;
      }
      rounds++;
      bytes += String(r.f[2]).length / 2;
      const next = await neg.reconcile(r.f[2] as string, () => {}, () => need++);
      if (!next) break;
      msg = ["NEG-MSG", sub, next];
    }
    c.send(["NEG-CLOSE", sub]);
    rows.push({ sync: k.name, "client items": localN, need, rounds, "relay bytes": bytes, ms: Math.round(performance.now() - t0), ...(err ? { error: err } : {}) });
  }
  c.close();
  report(`${db}: NIP-77 negentropy on ${n.toLocaleString("en-US")} events`, rows);
}

// ---------------------------------------------------------------- many connections

async function benchConns(db: DbKind) {
  const target = Number(args.conns);
  const srv = await server(db, { statsMs: 1000 });
  const rows: Record<string, unknown>[] = [];
  try {
    const before = srv.stats.at(-1);
    const t0 = performance.now();
    const { conns, failed, errors } = await connectMany(srv.ws, target, 500);
    const connectSecs = (performance.now() - t0) / 1000;
    // each holds one live subscription (typical idle client)
    await pool(conns, 500, async (c, i) => void (await c.req(`s${i}`, [{ kinds: [1], authors: [authorPubkey(i % AUTHORS)], limit: 1 }], { live: () => {} })));
    await Bun.sleep(1500);
    const after = srv.stats.at(-1);
    const fds = await srv.fds();
    // a REQ round trip while all of them are connected
    const probe = await LoadConn.connect(srv.ws);
    const s = new Samples();
    for (let i = 0; i < 20; i++) s.add((await probe.req(`p${i}`, [{ kinds: [1], limit: 10 }])).ms);
    probe.close();
    rows.push({
      target,
      connected: conns.length,
      failed,
      errors: errors.join("; "),
      "connect s": round(connectSecs, 1),
      "server conns": after?.conns,
      "rss MB before": before ? mb(before.rss) : "",
      "rss MB after": after ? mb(after.rss) : "",
      "KB per conn": after && before ? round((after.rss - before.rss) / 1024 / Math.max(1, conns.length), 1) : "",
      fds,
      "probe REQ p50 ms": round(s.pct(50)),
      "probe REQ p99 ms": round(s.pct(99)),
    });
    for (const c of conns) c.close();
    await Bun.sleep(3000);
    const closed = srv.stats.at(-1);
    rows.push({ target: "after close", "server conns": closed?.conns, "rss MB after": closed ? mb(closed.rss) : "", fds: await srv.fds() });
  } finally {
    await srv.stop();
    srv.cleanup();
  }
  report(`${db}: concurrent connections`, rows);
}

// ---------------------------------------------------------------- blossom

async function benchBlossom(db: DbKind) {
  // every client is 127.0.0.1: lift the per-IP / per-pubkey upload limits (the ingest concurrency limits stay)
  const env = { BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_IP: "0", BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_PUBKEY: "0", BEAMHOP_BLOSSOM_MAX_UPLOADS_PER_IP: "0" };
  const srv = await server(db, { statsMs: 1000, env });
  const rows: Record<string, unknown>[] = [];
  try {
    const signer = newSigner();
    for (const [size, count, parallel] of [
      [64 * 1024, 400, 16],
      [4 * 1024 * 1024, 60, 8],
    ]) {
      const blobs = Array.from({ length: count }, (_, i) => {
        const b = new Uint8Array(size);
        crypto.getRandomValues(b.subarray(0, Math.min(size, 65536)));
        b[0] = 0x25; // "%PDF" so the type sniffing accepts it as application/pdf
        b.set([0x25, 0x50, 0x44, 0x46], 0);
        new DataView(b.buffer).setUint32(8, i);
        return b;
      });
      const up = new Samples();
      const statuses = new Map<number, number>();
      const hashes: string[] = [];
      let bytes = 0;
      const t0 = performance.now();
      await pool(blobs, parallel, async (b) => {
        const hash = sha256(b);
        const t = performance.now();
        const res = await fetch(`${srv.http}/upload`, {
          method: "PUT",
          body: b,
          headers: { Authorization: blossomAuth(signer.sk, "upload", { hash }), "Content-Type": "application/pdf", "X-SHA-256": hash },
        });
        await res.arrayBuffer();
        up.add(performance.now() - t);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (res.ok) {
          hashes.push(hash);
          bytes += b.length;
        }
      });
      const upSecs = (performance.now() - t0) / 1000;
      const down = new Samples();
      const t1 = performance.now();
      let downBytes = 0;
      const gets = Array.from({ length: hashes.length * 3 }, (_, i) => hashes[i % hashes.length]);
      await pool(gets, parallel * 4, async (h) => {
        const t = performance.now();
        const res = await fetch(`${srv.http}/${h}`);
        downBytes += (await res.arrayBuffer()).byteLength;
        down.add(performance.now() - t);
      });
      const downSecs = (performance.now() - t1) / 1000;
      rows.push({
        size: `${size / 1024} KiB`,
        parallel,
        uploads: count,
        statuses: [...statuses].map(([s, n]) => `${s}×${n}`).join(" "),
        "upload MB/s": round(bytes / 1024 / 1024 / upSecs, 1),
        "upload p50 ms": round(up.pct(50)),
        "upload p99 ms": round(up.pct(99)),
        "download MB/s": round(downBytes / 1024 / 1024 / downSecs, 1),
        "download p50 ms": round(down.pct(50)),
        "download p99 ms": round(down.pct(99)),
        "rss MB": mb(srv.stats.at(-1)?.rss ?? 0),
      });
    }
  } finally {
    await srv.stop();
    srv.cleanup();
  }
  report(`${db}: Blossom upload/download (fs)`, rows);
}

// ---------------------------------------------------------------- main

const SCENARIOS: [string, (db: DbKind) => Promise<void>][] = [
  ["write", benchWrite],
  ["fanout", benchFanout],
  ["conns", benchConns],
  ["blossom", benchBlossom],
  ["query", benchQuery],
  ["count", benchCount],
  ["neg", benchNeg],
];

for (const db of dbs) {
  for (const [name, fn] of SCENARIOS) {
    if (!only.has(name)) continue;
    console.error(`== ${db} ${name}`);
    try {
      await fn(db);
    } catch (err) {
      const msg = `\n### ${db}: ${name} FAILED\n\n\`\`\`\n${(err as Error).stack ?? err}\n\`\`\`\n`;
      out.push(msg);
      console.error(msg);
    }
  }
  const c = corpusCache.get(db);
  if (c) {
    await c.srv.stop();
    c.srv.cleanup();
  }
}

if (process.env.LOAD_REPORT) await Bun.write(process.env.LOAD_REPORT, out.join("\n"));
process.exit(0);
