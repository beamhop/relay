/**
 * Soak: a mixed workload for --minutes against one server process, sampling its memory, descriptors, connection /
 * subscription counts and database size, to spot leaks and unbounded growth.
 *
 *   bun e2e/load/soak.ts [--db sqlite|postgres] [--minutes 30] [--rate 200] [--idle 300]
 *
 * Workload: `idle` connections holding live subscriptions; writers publishing `rate` events/s (notes, reactions,
 * replaceable and ephemeral kinds, deletions); connection churn (open → REQ → close, a share dropped without a close
 * frame); COUNT and NEG-OPEN calls; and slow consumers (raw sockets that subscribe to everything and stop reading).
 */
import { statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Event } from "nostr-tools";
import { connectMany, LoadConn } from "./lib/client";
import { DEFAULT_PG_URL, psql, resetPostgres, ServerProc, type DbKind } from "./lib/server";
import { newSigner, signAll, type SignJob } from "./lib/sign";
import { mb, round, table } from "./lib/stats";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: "sqlite" },
    minutes: { type: "string", default: "30" },
    rate: { type: "string", default: "200" },
    idle: { type: "string", default: "300" },
    "slow-every": { type: "string", default: "20" },
    "pg-url": { type: "string", default: DEFAULT_PG_URL },
    verbose: { type: "boolean", default: false },
  },
});
const db = args.db as DbKind;
const minutes = Number(args.minutes);
const rate = Number(args.rate);
const pgUrl = args["pg-url"]!;

if (db === "postgres") await resetPostgres(pgUrl);
const srv = await ServerProc.create({ db, pgUrl, statsMs: 5000, quiet: !args.verbose });
await srv.start();

const signers = Array.from({ length: 100 }, newSigner);
const now = () => Math.floor(Date.now() / 1000);
let stop = false;
const counters = { published: 0, acked: 0, refused: 0, churn: 0, dropped: 0, counts: 0, negs: 0, slow: 0, slowClosed: 0, liveReceived: 0, errors: 0 };
const refusals = new Map<string, number>();

/** Next second's worth of events, signed on workers: notes, reactions, replaceables, ephemerals and deletions. */
let recent: Event[] = [];
async function batch(n: number): Promise<Event[]> {
  const jobs: SignJob[] = [];
  for (let i = 0; i < n; i++) {
    const s = signers[Math.floor(Math.random() * signers.length)];
    const r = Math.random();
    const t = now();
    const ref = recent[Math.floor(Math.random() * recent.length)];
    if (r < 0.55) jobs.push({ sk: s.sk, t: { kind: 1, created_at: t, tags: [["t", `soak${i % 10}`]], content: `soak note ${crypto.randomUUID()}` } });
    else if (r < 0.8 && ref) jobs.push({ sk: s.sk, t: { kind: 7, created_at: t, tags: [["e", ref.id], ["p", ref.pubkey]], content: "+" } });
    else if (r < 0.88) jobs.push({ sk: s.sk, t: { kind: 30023, created_at: t, tags: [["d", `article${i % 5}`]], content: `long form ${crypto.randomUUID()}` } });
    else if (r < 0.93) jobs.push({ sk: s.sk, t: { kind: 0, created_at: t, tags: [], content: JSON.stringify({ name: `soak ${i}` }) } });
    else if (r < 0.98) jobs.push({ sk: s.sk, t: { kind: 20001, created_at: t, tags: [], content: "ephemeral" } });
    else {
      // deletion of one of this signer's recent notes (if any)
      const own = recent.find((e) => e.pubkey === s.pubkey && e.kind === 1);
      jobs.push({ sk: s.sk, t: { kind: 5, created_at: t, tags: own ? [["e", own.id]] : [], content: "" } });
    }
  }
  const evs = await signAll(jobs, 2);
  recent = [...recent.slice(-2000), ...evs.filter((e) => e.kind === 1)];
  return evs;
}

async function writers() {
  const { conns } = await connectMany(srv.ws, 20);
  let i = 0;
  while (!stop) {
    const t = performance.now();
    const evs = await batch(rate);
    for (const ev of evs) {
      const c = conns[i++ % conns.length];
      counters.published++;
      void c.publish(ev).then((r) => {
        if (r.ok) counters.acked++;
        else {
          counters.refused++;
          refusals.set(r.msg, (refusals.get(r.msg) ?? 0) + 1);
        }
      });
    }
    await Bun.sleep(Math.max(0, 1000 - (performance.now() - t)));
  }
  for (const c of conns) c.close();
}

async function idleSubscribers() {
  const { conns } = await connectMany(srv.ws, Number(args.idle));
  conns.forEach((c, i) => {
    const filters = [
      [{ kinds: [1], "#t": [`soak${i % 10}`], limit: 5 }],
      [{ authors: [signers[i % signers.length].pubkey], limit: 5 }],
      [{ kinds: [7], limit: 1 }],
      [{ kinds: [20001] }],
    ][i % 4];
    void c.req(`idle${i}`, filters, { live: () => counters.liveReceived++ });
  });
  while (!stop) await Bun.sleep(500);
  for (const c of conns) c.close();
}

/** open → REQ → close (every 4th one dropped without a close frame: the TCP socket is just destroyed). */
async function churn() {
  while (!stop) {
    await Promise.all(
      Array.from({ length: 10 }, async (_, k) => {
        try {
          const c = await LoadConn.connect(srv.ws, 10_000);
          await c.req("c", [{ kinds: [1], limit: 20 }]);
          if (k % 4 === 0) {
            // abrupt: no close handshake
            (c.ws as unknown as { terminate?: () => void }).terminate?.() ?? c.close();
            counters.dropped++;
          } else c.close();
          counters.churn++;
        } catch {
          counters.errors++;
        }
      }),
    );
    await Bun.sleep(1000);
  }
}

async function countsAndNeg() {
  const c = await LoadConn.connect(srv.ws);
  let i = 0;
  while (!stop) {
    await c.request(["COUNT", `n${i}`, { kinds: [1] }], `n${i}`, ["COUNT"]);
    counters.counts++;
    // NEG-OPEN with an empty client set (initial message: protocol V1, one IdList range of 0 ids), then close
    const r = await c.request(["NEG-OPEN", `g${i}`, { kinds: [7], limit: 5000 }, "6100000200"], `g${i}`, ["NEG-MSG", "NEG-ERR"]);
    if (r.f[0] === "NEG-MSG") c.send(["NEG-CLOSE", `g${i}`]);
    counters.negs++;
    i++;
    await Bun.sleep(2000);
  }
  c.close();
}

/** A websocket client that subscribes to everything and then stops reading: the relay must cut it off. */
function slowConsumer(): Promise<void> {
  return new Promise((resolve) => {
    const s: Socket = connect(srv.port, "127.0.0.1");
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    let upgraded = false;
    s.on("data", (d) => {
      if (upgraded) return;
      if (!d.toString("latin1").startsWith("HTTP/1.1 101")) return s.destroy();
      upgraded = true;
      s.write(wsFrame(JSON.stringify(["REQ", "all", { limit: 500 }, { kinds: [1, 7, 20001] }])));
      // stop reading: the kernel buffers fill, then the relay's send buffer
      s.pause();
    });
    s.on("close", () => {
      counters.slowClosed++;
      resolve();
    });
    s.on("error", () => {});
    s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    counters.slow++;
    // give up on it after 5 minutes (counted as not closed by the relay)
    setTimeout(() => s.destroy(), 5 * 60_000).unref();
  });
}

/** Client → server text frame (masked). */
function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]) : (() => {
    const b = Buffer.alloc(10);
    b[0] = 0x81;
    b[1] = 0x80 | 127;
    b.writeBigUInt64BE(BigInt(len), 2);
    return b;
  })();
  const masked = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
  return Buffer.concat([head, Buffer.from(mask), masked]);
}

async function slowConsumers() {
  const every = Number(args["slow-every"]) * 1000;
  while (!stop) {
    void slowConsumer();
    await Bun.sleep(every);
  }
}

// ---------------------------------------------------------------- sampling

interface Sample {
  min: number;
  rssMB: number;
  heapMB: number;
  heapObjects: number;
  fds: number;
  conns: number;
  subs: number;
  dbMB: number;
  walMB: number;
  maps: number;
  sets: number;
  promises: number;
  acked: number;
  liveRecv: number;
  slowOpen: number;
}
const samples: Sample[] = [];
async function dbSize(): Promise<{ db: number; wal: number }> {
  if (db === "sqlite") {
    const size = (f: string) => {
      try {
        return statSync(join(srv.dir, f)).size;
      } catch {
        return 0;
      }
    };
    return { db: size("beamhop.db"), wal: size("beamhop.db-wal") };
  }
  const n = Number((await psql(pgUrl, "SELECT pg_database_size(current_database())")).trim());
  return { db: n, wal: 0 };
}
async function sample(t0: number) {
  const s = srv.stats.at(-1);
  const m = await srv.metrics().catch(() => ({}) as Record<string, number>);
  const size = await dbSize();
  const row: Sample = {
    min: round((Date.now() - t0) / 60_000, 1),
    rssMB: s ? mb(s.rss) : NaN,
    heapMB: s ? mb(s.heapUsed) : NaN,
    heapObjects: s?.heapObjects ?? NaN,
    fds: await srv.fds(),
    conns: s?.conns ?? NaN,
    subs: m.beamhop_subscriptions ?? NaN,
    dbMB: mb(size.db),
    walMB: mb(size.wal),
    maps: s?.objects.Map ?? NaN,
    sets: s?.objects.Set ?? NaN,
    promises: s?.objects.Promise ?? NaN,
    acked: counters.acked,
    liveRecv: counters.liveReceived,
    slowOpen: counters.slow - counters.slowClosed,
  };
  samples.push(row);
  console.log(JSON.stringify(row));
}

const t0 = Date.now();
const tasks = [writers(), idleSubscribers(), churn(), countsAndNeg(), slowConsumers()];
const end = t0 + minutes * 60_000;
while (Date.now() < end && srv.exitCode === undefined) {
  await sample(t0);
  await Bun.sleep(30_000);
}
stop = true;
await Promise.race([Promise.all(tasks), Bun.sleep(15_000)]);
await Bun.sleep(5000);
await sample(t0); // after the load stopped: connections and subscriptions should be back near zero
const alive = srv.exitCode === undefined;
await srv.stop();

/** least-squares slope per minute over the second half (after warm-up) */
const slope = (k: keyof Sample) => {
  const xs = samples.slice(Math.floor(samples.length / 2), -1);
  if (xs.length < 3) return NaN;
  const mx = xs.reduce((a, s) => a + s.min, 0) / xs.length;
  const my = xs.reduce((a, s) => a + (s[k] as number), 0) / xs.length;
  const num = xs.reduce((a, s) => a + (s.min - mx) * ((s[k] as number) - my), 0);
  const den = xs.reduce((a, s) => a + (s.min - mx) ** 2, 0);
  return round(num / den, 3);
};
const summary =
  `\n### ${db}: soak ${minutes} min, ${rate} ev/s, ${args.idle} idle subscribers\n\n` +
  table(samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 12)) === 0 || i === samples.length - 1) as never) +
  `\n\nserver alive at the end: ${alive}; counters: ${JSON.stringify(counters)}\n` +
  `refusals: ${[...refusals].map(([m, n]) => `${m}×${n}`).join("; ") || "none"}\n` +
  `slopes over the second half (per minute): rss ${slope("rssMB")} MB, heap ${slope("heapMB")} MB, heap objects ${slope("heapObjects")}, fds ${slope("fds")}, maps ${slope("maps")}, sets ${slope("sets")}, promises ${slope("promises")}\n`;
console.log(summary);
if (process.env.LOAD_REPORT) await Bun.write(process.env.LOAD_REPORT, summary);
srv.cleanup();
process.exit(0);
