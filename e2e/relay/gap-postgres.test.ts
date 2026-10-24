/**
 * Postgres parity: the same events published to a SQLite relay and a Postgres relay must answer the same REQ/COUNT
 * queries identically. Opt-in like packages/storage/test/postgres.test.ts: runs only with
 * BEAMHOP_TEST_PG=postgres://… set. It works in a throwaway schema (search_path) that is dropped afterwards, so no
 * existing tables are touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { RelayClient, newUser, sha256, sign } from "../harness/client";
import { upload } from "./admin-helpers";
import { RELAXED_LIMITS, rand } from "./core-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

const PG = process.env.BEAMHOP_TEST_PG;
const schema = `beamhop_e2e_${rand(4)}`;

describe.skipIf(!PG)("postgres parity", () => {
  let sqlite: GapRelay;
  let pg: GapRelay;
  let cs: RelayClient;
  let cp: RelayClient;
  let admin: { end(): Promise<void>; unsafe(q: string): Promise<unknown> };

  beforeAll(async () => {
    const { default: postgres } = await import("../../packages/storage/node_modules/postgres");
    admin = postgres(PG!, { max: 1, onnotice: () => {} }) as never;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const url = new URL(PG!);
    url.searchParams.set("search_path", schema);
    sqlite = await bootGap();
    pg = await bootGap({ overrides: { database: { driver: "postgres", postgresUrl: url.toString() } } });
    for (const r of [sqlite, pg]) {
      const { api } = await import("./admin-helpers");
      const s = await api(r.http, r.owner.sk, "PATCH", "/settings", { limits: RELAXED_LIMITS, blossom: { uploadAccess: "anyone" } });
      if (s.status !== 200) throw new Error(`settings ${s.status}`);
    }
    cs = await RelayClient.connect(sqlite.ws);
    cp = await RelayClient.connect(pg.ws);
  }, 60_000);
  afterAll(async () => {
    cs?.close();
    cp?.close();
    await sqlite?.stop();
    await pg?.stop();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end();
    }
  });

  const both = async (ev: Event) => {
    const [a, b] = await Promise.all([cs.publish(ev), cp.publish(ev)]);
    expect(b).toEqual(a);
    return a;
  };
  let q = 0;
  const same = async (filters: Record<string, unknown>[]) => {
    const id = `p${++q}`;
    const [a, b] = await Promise.all([cs.query(id, filters), cp.query(id, filters)]);
    expect(b.closed).toEqual(a.closed);
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    for (let i = 0; i < a.events.length; i++) expect(b.events[i].content).toBe(a.events[i].content);
    return a.events;
  };

  test("NIP-01 queries, ordering ties, replaceable/addressable, deletion and unicode answer identically", async () => {
    const u = newUser();
    const v = newUser();
    const T = Math.floor(Date.now() / 1000) - 1000;
    const tag = `pg-${rand()}`;
    const evs: Event[] = [];
    for (let i = 0; i < 40; i++) {
      const who = i % 3 ? u : v;
      evs.push(sign(who.sk, { kind: i % 4 ? 1 : 7, content: `parity ${i} ünï 🚀 needle${i % 5}`, created_at: T + Math.floor(i / 2), tags: [["t", tag], ["p", v.pubkey], ["T", `up${i % 2}`]] }));
    }
    for (const e of evs) await both(e);
    await both(sign(u.sk, { kind: 0, content: '{"name":"a"}', created_at: T }));
    await both(sign(u.sk, { kind: 0, content: '{"name":"b"}', created_at: T + 1 }));
    await both(sign(u.sk, { kind: 0, content: '{"name":"old"}', created_at: T - 5 }));
    await both(sign(u.sk, { kind: 30078, tags: [["d", "x"]], content: "1", created_at: T }));
    await both(sign(u.sk, { kind: 30078, tags: [["d", "x"]], content: "2", created_at: T + 3 }));
    await both(sign(u.sk, { kind: 5, tags: [["e", evs[1].id]] }));
    await both(evs[1]); // re-publish after deletion

    await same([{ "#t": [tag] }]);
    await same([{ "#t": [tag], limit: 7 }]);
    await same([{ authors: [u.pubkey], kinds: [1] }]);
    await same([{ "#T": ["up1"], "#t": [tag] }]);
    await same([{ "#t": [tag], since: T + 5, until: T + 12 }]);
    await same([{ "#t": [tag], kinds: [7] }, { authors: [v.pubkey], limit: 3 }]);
    await same([{ kinds: [0], authors: [u.pubkey] }]);
    await same([{ kinds: [30078], authors: [u.pubkey], "#d": ["x"] }]);
    await same([{ ids: evs.slice(0, 10).map((e) => e.id) }]);
    await same([{ "#t": [tag], search: "needle3" }]);
    const [ca, cb] = await Promise.all([cs, cp].map(async (c) => {
      c.send(["COUNT", "cnt", { "#t": [tag] }]);
      return (await c.waitFor((m) => m[0] === "COUNT" && m[1] === "cnt"))[2];
    }));
    expect(cb).toEqual(ca);
  }, 60_000);

  test("unicode edge cases are stored identically (including a leading BOM)", async () => {
    const u = newUser();
    for (const content of ["﻿bom first", "a b", "👨‍👩‍👧 café", "tab\tquote\"back\\"]) {
      const ev = sign(u.sk, { kind: 1, content });
      await both(ev);
      const got = await same([{ ids: [ev.id] }]);
      expect(got[0]?.content).toBe(content);
    }
  });

  test("blossom on postgres: upload, descriptor and list", async () => {
    const u = newUser();
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n%${rand()}\n%%EOF\n`));
    const up = await upload(pg.http, u.sk, bytes, { type: "application/pdf" });
    expect(up.status).toBe(201);
    const got = await fetch(`${pg.http}/${up.sha}`);
    expect(sha256(new Uint8Array(await got.arrayBuffer()))).toBe(up.sha);
    const again = await upload(pg.http, u.sk, bytes, { type: "application/pdf" });
    expect(again.status).toBe(200);
  });
});

