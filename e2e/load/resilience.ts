/**
 * Crash / shutdown / outage drills against a server process under write load. Every EVENT answered OK true must be
 * in the database afterwards, and the database must pass its integrity checks.
 *
 *   bun e2e/load/resilience.ts [--db sqlite,postgres] [--only kill9,sigterm,pgdown,diskfull] [--cycles 5]
 *
 * pgdown runs its own throwaway postgres cluster (initdb in a temp dir, a free port) so it can be stopped and
 * started without touching the shared server. diskfull (sqlite, macOS) puts the data dir on a small disk image.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Event } from "nostr-tools";
import { freePort } from "../harness/relay";
import { connectMany, LoadConn } from "./lib/client";
import { DEFAULT_PG_URL, psql, resetPostgres, ServerProc, type DbKind } from "./lib/server";
import { makeNotes, newSigner } from "./lib/sign";
import { round, Samples, table } from "./lib/stats";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: "sqlite,postgres" },
    only: { type: "string", default: "kill9,sigterm,pgdown,diskfull" },
    cycles: { type: "string", default: "5" },
    "pg-url": { type: "string", default: DEFAULT_PG_URL },
    verbose: { type: "boolean", default: false },
  },
});
const only = new Set(args.only!.split(","));
const cycles = Number(args.cycles);
const out: string[] = [];
function report(title: string, rows: Record<string, unknown>[]) {
  const s = `\n### ${title}\n\n${table(rows)}\n`;
  out.push(s);
  console.log(s);
}

/** Publishes `events` over `conns` connections (window 10 each) until done or stopped; tracks acked ids. */
function writer(url: string, events: Event[], conns = 20) {
  const acked = new Set<string>();
  const refused = new Map<string, number>();
  let unanswered = 0;
  let sent = 0;
  let stop = false;
  const done = (async () => {
    const { conns: cs } = await connectMany(url, conns);
    let next = 0;
    await Promise.all(
      cs.map((c) =>
        Promise.all(
          Array.from({ length: 10 }, async () => {
            while (!stop && next < events.length && !c.closed) {
              const ev = events[next++];
              sent++;
              const r = await c.publish(ev);
              if (r.ok) acked.add(ev.id);
              else if (r.msg.startsWith("closed")) unanswered++;
              else refused.set(r.msg, (refused.get(r.msg) ?? 0) + 1);
            }
          }),
        ),
      ),
    );
    for (const c of cs) c.close();
  })();
  return {
    acked,
    refused,
    get sent() {
      return sent;
    },
    get unanswered() {
      return unanswered;
    },
    stop() {
      stop = true;
      return done;
    },
    done,
  };
}

/** ids stored (read straight from the database) */
async function storedIds(srv: ServerProc, pgUrl: string): Promise<Set<string>> {
  if (srv.opts.db === "sqlite") {
    const db = new Database(join(srv.dir, "beamhop.db"), { readonly: true });
    try {
      return new Set((db.query("SELECT id FROM events").all() as { id: string }[]).map((r) => r.id));
    } finally {
      db.close();
    }
  }
  return new Set((await psql(pgUrl, "SELECT id FROM events")).split("\n").filter(Boolean));
}

/** sqlite: integrity_check of the database and the FTS index (server stopped). */
function sqliteIntegrity(dir: string): string {
  const db = new Database(join(dir, "beamhop.db"));
  try {
    const ic = (db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join(",");
    let fts = "ok";
    try {
      db.exec("INSERT INTO events_fts(events_fts) VALUES('integrity-check')");
    } catch (e) {
      fts = (e as Error).message;
    }
    // every indexed tag row points at an event
    const orphans = (db.query("SELECT COUNT(*) AS n FROM event_tags t LEFT JOIN events e ON e.seq = t.event_seq WHERE e.seq IS NULL").get() as { n: number }).n;
    return `${ic}; fts ${fts}; orphan tags ${orphans}`;
  } finally {
    db.close();
  }
}

async function healthStatus(srv: ServerProc): Promise<number> {
  try {
    const r = await fetch(`${srv.http}/health`, { signal: AbortSignal.timeout(5000) });
    return r.status;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- kill -9

async function kill9(db: DbKind, pgUrl: string) {
  if (db === "postgres") await resetPostgres(pgUrl);
  const srv = await ServerProc.create({ db, pgUrl, quiet: !args.verbose });
  const signers = Array.from({ length: 50 }, newSigner);
  const rows: Record<string, unknown>[] = [];
  await srv.start();
  try {
    const allAcked = new Set<string>();
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const events = await makeNotes(40_000, signers);
      const w = writer(srv.ws, events);
      await Bun.sleep(1500 + Math.random() * 2500);
      srv.kill("SIGKILL");
      await srv.waitExit();
      await w.stop();
      for (const id of w.acked) allAcked.add(id);
      const integrity = db === "sqlite" ? sqliteIntegrity(srv.dir) : "n/a";
      const t0 = performance.now();
      await srv.start();
      const restartMs = Math.round(performance.now() - t0);
      const stored = await storedIds(srv, pgUrl);
      const lost = [...allAcked].filter((id) => !stored.has(id)).length;
      rows.push({ cycle, sent: w.sent, acked: w.acked.size, "acked lost": lost, "cut off (no OK)": w.unanswered, "stored total": stored.size, integrity, "restart ms": restartMs });
    }
  } finally {
    await srv.stop();
    srv.cleanup();
  }
  report(`${db}: kill -9 under write load`, rows);
}

// ---------------------------------------------------------------- SIGTERM drain

async function sigterm(db: DbKind, pgUrl: string) {
  if (db === "postgres") await resetPostgres(pgUrl);
  const srv = await ServerProc.create({ db, pgUrl, quiet: !args.verbose });
  const signers = Array.from({ length: 50 }, newSigner);
  const rows: Record<string, unknown>[] = [];
  await srv.start();
  try {
    for (let cycle = 1; cycle <= Math.min(3, cycles); cycle++) {
      const events = await makeNotes(40_000, signers);
      const w = writer(srv.ws, events);
      // a live subscriber: it should see a clean close (1001), not 1006
      const sub = await LoadConn.connect(srv.ws);
      void sub.req("live", [{ kinds: [1], limit: 0 }], { live: () => {} });
      await Bun.sleep(2000);
      const t0 = performance.now();
      srv.kill("SIGTERM");
      const code = await srv.waitExit(30_000);
      const shutdownMs = Math.round(performance.now() - t0);
      await w.stop();
      const integrity = db === "sqlite" ? sqliteIntegrity(srv.dir) : "n/a";
      await srv.start();
      const stored = await storedIds(srv, pgUrl);
      const lost = [...w.acked].filter((id) => !stored.has(id)).length;
      rows.push({
        cycle,
        "exit code": code,
        "shutdown ms": shutdownMs,
        acked: w.acked.size,
        "acked lost": lost,
        refused: [...w.refused].map(([m, n]) => `${m}×${n}`).join("; "),
        "cut off (no OK)": w.unanswered,
        "subscriber close code": sub.closeCode,
        integrity,
      });
    }
  } finally {
    await srv.stop();
    srv.cleanup();
  }
  report(`${db}: SIGTERM under write load`, rows);
}

// ---------------------------------------------------------------- postgres outage

async function pgdown() {
  const dir = mkdtempSync(join(tmpdir(), "beamhop-pg-"));
  const port = await freePort();
  const run = async (cmd: string[]) => {
    // postgres refuses to start with an unusable locale ("postmaster became multithreaded during startup")
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    const [o, e, c] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (c !== 0) throw new Error(`${cmd.join(" ")}: ${e || o}`);
  };
  const pgctl = (action: string, ...extra: string[]) =>
    run(["pg_ctl", "-D", join(dir, "data"), "-l", join(dir, "pg.log"), "-w", "-o", `-p ${port} -c unix_socket_directories='' -c listen_addresses=127.0.0.1`, ...extra, action]);
  const rows: Record<string, unknown>[] = [];
  let srv: ServerProc | undefined;
  try {
    await run(["initdb", "-D", join(dir, "data"), "-U", "beamhop", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    await pgctl("start");
    const url = `postgres://beamhop@127.0.0.1:${port}/postgres`;
    srv = await ServerProc.create({ db: "postgres", pgUrl: url, quiet: !args.verbose });
    await srv.start();
    const signers = Array.from({ length: 50 }, newSigner);
    const events = await makeNotes(200_000, signers);
    const w = writer(srv.ws, events, 10);
    const timeline: string[] = [];
    const t0 = performance.now();
    const at = () => `${round((performance.now() - t0) / 1000, 1)}s`;
    await Bun.sleep(2000);
    const ackedBefore = w.acked.size;
    timeline.push(`${at()} stopping postgres (fast), acked ${ackedBefore}, health ${await healthStatus(srv)}`);
    await pgctl("stop", "-m", "fast");
    // health must turn 503 while the database is gone; writes must fail (not hang)
    const health = new Samples();
    let h503 = 0;
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      const s = await healthStatus(srv);
      health.add(performance.now() - t);
      if (s === 503) h503++;
      await Bun.sleep(500);
    }
    const ackedDuring = w.acked.size - ackedBefore;
    timeline.push(`${at()} down 5s: /health 503 ${h503}/10 (p99 ${round(health.pct(99))} ms), acked while down ${ackedDuring}, refusals ${[...w.refused].map(([m, n]) => `${m}×${n}`).join("; ")}`);
    const probe = await LoadConn.connect(srv.ws).catch(() => undefined);
    const req = probe ? await Promise.race([probe.req("down", [{ kinds: [1], limit: 5 }]), Bun.sleep(10_000).then(() => ({ n: -1, ms: 10_000, closed: "no answer in 10 s" }))]) : undefined;
    timeline.push(`${at()} REQ while down: ${JSON.stringify(req)}`);
    await pgctl("start");
    const tUp = performance.now();
    let healthy = -1;
    for (let i = 0; i < 120; i++) {
      if ((await healthStatus(srv)) === 200) {
        healthy = Math.round(performance.now() - tUp);
        break;
      }
      await Bun.sleep(250);
    }
    const ackedAtRestart = w.acked.size;
    await Bun.sleep(3000);
    timeline.push(`${at()} postgres back: /health 200 after ${healthy} ms; acked in 3 s after: ${w.acked.size - ackedAtRestart}; server alive: ${srv.exitCode === undefined}`);
    const req2 = probe ? await probe.req("up", [{ kinds: [1], limit: 5 }]) : undefined;
    timeline.push(`${at()} REQ after: ${JSON.stringify(req2)}`);
    await w.stop();
    probe?.close();
    const stored = await storedIds(srv, url);
    const lost = [...w.acked].filter((id) => !stored.has(id)).length;
    rows.push({ acked: w.acked.size, "acked lost": lost, timeline: timeline.join("<br>") });
    console.log(timeline.join("\n"));
  } finally {
    await srv?.stop();
    srv?.cleanup();
    await pgctl("stop", "-m", "immediate").catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  report("postgres: database stopped and restarted under write load", rows);
}

// ---------------------------------------------------------------- disk full (sqlite, macOS disk image)

async function diskfull() {
  if (process.platform !== "darwin") return console.log("diskfull: macOS only (hdiutil)");
  const base = mkdtempSync(join(tmpdir(), "beamhop-full-"));
  const img = join(base, "small.dmg");
  const mnt = join(base, "mnt");
  const run = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [o, e, c] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (c !== 0) throw new Error(`${cmd.join(" ")}: ${e || o}`);
    return o;
  };
  const rows: Record<string, unknown>[] = [];
  let srv: ServerProc | undefined;
  let attached = false;
  try {
    await run(["hdiutil", "create", "-size", "40m", "-fs", "HFS+", "-volname", "beamhopfull", img]);
    await run(["hdiutil", "attach", img, "-mountpoint", mnt, "-nobrowse"]);
    attached = true;
    srv = await ServerProc.create({ db: "sqlite", dir: join(mnt, "data"), quiet: !args.verbose });
    await srv.start();
    // filler: leave ~3 MB free
    const df = await run(["df", "-k", mnt]);
    const free = Number(df.trim().split("\n")[1].split(/\s+/)[3]) * 1024;
    writeFileSync(join(mnt, "filler"), new Uint8Array(Math.max(0, free - 3 * 1024 * 1024)));
    const signers = Array.from({ length: 20 }, newSigner);
    const events = await makeNotes(30_000, signers, { content: (i) => `${"x".repeat(2000)} ${i}` });
    const w = writer(srv.ws, events, 10);
    await Bun.sleep(8000);
    const health = await healthStatus(srv);
    const acked = w.acked.size;
    const refused = [...w.refused].map(([m, n]) => `${m}×${n}`).join("; ");
    // free the space again: writes should resume without a restart
    rmSync(join(mnt, "filler"));
    const before = w.acked.size;
    await Bun.sleep(3000);
    const resumed = w.acked.size - before;
    await w.stop();
    const alive = srv.exitCode === undefined;
    await srv.stop();
    const integrity = sqliteIntegrity(srv.dir);
    const stored = await storedIds(srv, "");
    const lost = [...w.acked].filter((id) => !stored.has(id)).length;
    rows.push({ "acked while filling": acked, refused, "health when full": health, "acked after freeing (3 s)": resumed, "server alive": alive, "acked lost": lost, integrity });
  } finally {
    if (srv && srv.exitCode === undefined) await srv.stop();
    if (attached) await run(["hdiutil", "detach", mnt, "-force"]).catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
  report("sqlite: disk full (40 MB disk image)", rows);
}

// ---------------------------------------------------------------- main

const pgUrl = args["pg-url"]!;
for (const db of args.db!.split(",") as DbKind[]) {
  for (const [name, fn] of [
    ["kill9", () => kill9(db, pgUrl)],
    ["sigterm", () => sigterm(db, pgUrl)],
    ["pgdown", () => (db === "postgres" ? pgdown() : undefined)],
    ["diskfull", () => (db === "sqlite" ? diskfull() : undefined)],
  ] as const) {
    if (!only.has(name)) continue;
    console.error(`== ${db} ${name}`);
    try {
      await fn();
    } catch (err) {
      const msg = `\n### ${db}: ${name} FAILED\n\n\`\`\`\n${(err as Error).stack ?? err}\n\`\`\`\n`;
      out.push(msg);
      console.error(msg);
    }
  }
}
if (process.env.LOAD_REPORT) await Bun.write(process.env.LOAD_REPORT, out.join("\n"));
process.exit(0);
