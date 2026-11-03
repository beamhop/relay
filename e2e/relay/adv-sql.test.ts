/**
 * SQL / full-text injection through every user-controlled query input — REQ filters (ids, authors, tag names and values,
 * search), COUNT, the admin user search and event query — on SQLite and, when BEAMHOP_TEST_PG=postgres://… is set, on
 * Postgres (in a throwaway schema). Hostile strings must match only themselves, never error the query, never widen
 * results, and leave the database intact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { RelayClient, newUser, sign } from "../harness/client";
import { api } from "./admin-helpers";
import { RELAXED_LIMITS, rand } from "./core-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

const PG = process.env.BEAMHOP_TEST_PG;

/** classic SQL breakouts, LIKE wildcards, FTS5 and tsquery operators, control characters */
const HOSTILE = [
  "' OR '1'='1",
  "x'; DROP TABLE events; --",
  '" OR ""="',
  "') UNION SELECT id, pubkey, created_at, kind, tags, content, sig FROM events --",
  "%",
  "_",
  "%%_%",
  "\\",
  "\\%",
  "*",
  "a* OR b*",
  "NEAR(a b)",
  "content:secret",
  "^start",
  '"unterminated',
  "-negated",
  "!x & y | z",
  "a <-> b",
  "x:*",
  "(((((",
  "line\nbreak",
  "😀 ｆｕｌｌ ｗｉｄｔｈ",
];
/** content with NUL is refused on publish (Postgres can't store it), so these are only ever queried */
const QUERY_ONLY = ["\u0000nul", "x\u0000' OR 1=1 --"];

const backends: [string, () => Record<string, unknown> | undefined][] = [["sqlite", () => undefined]];
if (PG) backends.push(["postgres", () => ({ database: { driver: "postgres", postgresUrl: pgUrl } })]);
let pgUrl = "";
let pgAdmin: { end(): Promise<void>; unsafe(q: string): Promise<unknown> } | undefined;
const schema = `beamhop_sec_${rand(4)}`;

beforeAll(async () => {
  if (!PG) return;
  const { default: postgres } = await import("../../packages/storage/node_modules/postgres");
  const admin: NonNullable<typeof pgAdmin> = postgres(PG, { max: 1, onnotice: () => {} }) as never;
  pgAdmin = admin;
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const u = new URL(PG);
  u.searchParams.set("search_path", schema);
  pgUrl = u.toString();
});
afterAll(async () => {
  if (!pgAdmin) return;
  await pgAdmin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await pgAdmin.end();
});

for (const [name, overrides] of backends) {
  describe(`${name}: injection through queries`, () => {
    let relay: GapRelay;
    let c: RelayClient;
    const author = newUser();
    const events: Event[] = [];
    let q = 0;
    const query = (filters: Record<string, unknown>[]) => c.query(`q${++q}`, filters);

    beforeAll(async () => {
      relay = await bootGap({ overrides: overrides() });
      expect((await api(relay.http, relay.owner.sk, "PATCH", "/settings", { limits: RELAXED_LIMITS })).status).toBe(200);
      c = await RelayClient.connect(relay.ws);
      // one event per hostile string (as content and as a t tag), plus a plain control event
      for (const h of [...HOSTILE, "plain control note"]) {
        const ev = sign(author.sk, { kind: 1, content: `note ${h} body`, tags: [["t", h]] });
        const r = await c.publish(ev);
        expect([h, r]).toEqual([h, { ok: true, message: r.message }]);
        events.push(ev);
      }
    }, 60_000);
    afterAll(async () => {
      c?.close();
      await relay?.stop(true);
    });

    test("hostile tag values match exactly their own event, never more", async () => {
      for (const [i, h] of HOSTILE.entries()) {
        const r = await query([{ "#t": [h] }]);
        expect([h, r.closed, r.events.map((e) => e.id)]).toEqual([h, undefined, [events[i].id]]);
      }
    });

    test("hostile tag names and values in odd places are refused or match nothing", async () => {
      for (const h of [...HOSTILE, ...QUERY_ONLY]) {
        for (const f of [{ [`#${h}`]: ["x"] }, { "#t": [h, `${h}x`], kinds: [1], authors: [author.pubkey] }, { "#e": [h] }, { "#p": [h] }]) {
          const r = await query([f]);
          expect(r.events.length).toBeLessThanOrEqual(1);
        }
      }
    });

    test("ids / authors with wildcard or quote characters are refused as invalid, not run as patterns", async () => {
      for (const h of ["%", "_", "' OR 1=1 --", `${author.pubkey.slice(0, 10)}%`, "a".repeat(63) + "%"]) {
        for (const key of ["ids", "authors"]) {
          const r = await query([{ [key]: [h] }]);
          expect([key, h, r.events.length]).toEqual([key, h, 0]);
        }
      }
    });

    test("search: operators are literal text; no errors, no widening", async () => {
      for (const h of [...HOSTILE, ...QUERY_ONLY]) {
        const r = await query([{ search: h, kinds: [1] }]);
        expect(r.closed ?? "").not.toMatch(/error|syntax|sql|fts|tsquery/i);
        // a search can only return the seeded notes, and never all of them
        expect(r.events.length).toBeLessThan(events.length);
      }
      const r = await query([{ search: "' OR '1'='1", kinds: [1] }]);
      expect(r.events.every((e) => e.content.includes("OR"))).toBe(true);
    });

    test("COUNT with hostile values answers numbers", async () => {
      for (const h of HOSTILE.slice(0, 6)) {
        c.send(["COUNT", `c${++q}`, { "#t": [h] }]);
        const m = await c.waitFor((f) => (f[0] === "COUNT" || f[0] === "CLOSED") && f[1] === `c${q}`);
        expect(m[0]).toBe("COUNT");
        expect((m[2] as { count: number }).count).toBe(1);
      }
    });

    test("admin user search and event query treat hostile input as data", async () => {
      for (const h of HOSTILE) {
        const users = await api(relay.http, relay.owner.sk, "GET", `/users?search=${encodeURIComponent(h)}`);
        expect(users.status).toBeLessThan(500);
        if (users.status === 200) expect(users.body.items.length).toBeLessThanOrEqual(1);
        const evq = await api(relay.http, relay.owner.sk, "POST", "/events/query", { filters: [{ "#t": [h], search: h }] });
        expect(evq.status).toBeLessThan(500);
        const audit = await api(relay.http, relay.owner.sk, "GET", `/audit?action=${encodeURIComponent(h)}&target=${encodeURIComponent(h)}`);
        expect(audit.status).toBeLessThan(500);
        if (audit.status === 200) expect(audit.body.items).toEqual([]);
      }
    });

    test("afterwards every seeded event is still there", async () => {
      const r = await query([{ authors: [author.pubkey], limit: 500 }]);
      expect(r.events.length).toBe(events.length);
    });
  });
}
