/**
 * Spec-conformance probes for NIP-45 (COUNT), NIP-50 (search), NIP-77 (negentropy), NIP-11 and NIP-05.
 * Black-box over ws/http. The negentropy client below is written from the NIP-77 appendix (Negentropy
 * Protocol V1) only; it shares no code with the relay or with any reference implementation.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, now, sign, type Msg } from "../harness/client";
import { connectAs, connectAuthed, nextSub, uniqueIp } from "./policy-helpers";
import { RELAXED_LIMITS, patchSettings, publishOk, rand } from "./core-helpers";

let relay: Relay;
const open: RelayClient[] = [];
beforeAll(async () => {
  // trustProxy: bulk publishing spreads over several (forwarded) client addresses, under the per-address message limit
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
  await patchSettings(relay, { limits: RELAXED_LIMITS });
});
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});
afterAll(() => relay?.stop());

const conn = async (ip = uniqueIp()) => {
  const c = await connectAs(relay, ip);
  open.push(c);
  return c;
};
const authed = async (sk: Uint8Array) => {
  const c = await connectAuthed(relay, sk, uniqueIp());
  open.push(c);
  return c;
};
/** the owner is staff: exempt from the search buckets */
const staff = () => authed(relay.owner.sk);

async function count(c: RelayClient, filters: Record<string, unknown>[]): Promise<Msg> {
  const s = nextSub("cnt");
  c.send(["COUNT", s, ...filters]);
  return c.waitFor((m) => (m[0] === "COUNT" || m[0] === "CLOSED") && m[1] === s);
}
const idsOf = async (c: RelayClient, filters: Record<string, unknown>[]) => (await c.query(nextSub("q"), filters)).events.map((e) => e.id);
const sorted = (xs: string[]) => [...xs].sort();

/** Publishes many events (staff key: no event rate limit), at most 1000 per connection/address. */
async function bulkPublish(events: Event[]) {
  for (let i = 0; i < events.length; i += 1000) {
    const c = await conn();
    const part = events.slice(i, i + 1000);
    for (const e of part) c.send(["EVENT", e]);
    for (const e of part) expect((await c.waitFor((m) => m[0] === "OK" && m[1] === e.id, 30_000))[2]).toBe(true);
  }
}

// ====================================================================== NIP-45

/** NIP-45 HyperLogLog, relay side, exactly as the spec's "Algorithm" and "offset computation" sections describe. */
function hllOffset(filter: Record<string, unknown>): number {
  const key = Object.keys(filter).find((k) => k.startsWith("#"))!;
  const first = (filter[key] as string[])[0];
  let hex: string;
  if (/^[0-9a-f]{64}$/.test(first)) hex = first;
  else if (/^\d+:[0-9a-f]{64}:/.test(first)) hex = first.split(":")[1];
  else hex = createHash("sha256").update(first).digest("hex");
  return parseInt(hex[32], 16) + 8;
}
function hllRegisters(filter: Record<string, unknown>, pubkeys: string[]): string {
  const offset = hllOffset(filter);
  const regs = new Uint8Array(256);
  for (const pk of pubkeys) {
    const b = Buffer.from(pk, "hex");
    const ri = b[offset];
    let zeros = 0;
    for (let i = offset + 1; i < 32; i++) {
      if (b[i] === 0) {
        zeros += 8;
        continue;
      }
      zeros += Math.clz32(b[i]) - 24;
      break;
    }
    regs[ri] = Math.max(regs[ri], zeros + 1);
  }
  return Buffer.from(regs).toString("hex");
}

describe("NIP-45 COUNT", () => {
  test('response shape is ["COUNT", <id>, {"count": n}] with an integer count', async () => {
    const c = await conn();
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "x" }));
    const m = await count(c, [{ authors: [u.pubkey] }]);
    expect(m.length).toBe(3);
    expect(m[0]).toBe("COUNT");
    expect(Number.isInteger((m[2] as { count: number }).count)).toBe(true);
    expect((m[2] as { count: number }).count).toBe(1);
  });

  test("multiple filters: an event matched by several filters is counted once (union)", async () => {
    const c = await conn();
    const u = newUser();
    const tag = `t${rand(4)}`;
    await publishOk(c, sign(u.sk, { kind: 1, content: "a", tags: [["t", tag]] }));
    await publishOk(c, sign(u.sk, { kind: 1, content: "b" }));
    await publishOk(c, sign(u.sk, { kind: 7, content: "+", tags: [["t", tag]] }));
    const m = await count(c, [{ authors: [u.pubkey], kinds: [1] }, { "#t": [tag] }, { authors: [u.pubkey] }]);
    expect(m[2]).toEqual({ count: 3 });
  });

  test("events deleted with NIP-09 are not counted", async () => {
    const c = await conn();
    const u = newUser();
    const a = await publishOk(c, sign(u.sk, { kind: 1, content: "keep" }));
    const b = await publishOk(c, sign(u.sk, { kind: 1, content: "delete me" }));
    await publishOk(c, sign(u.sk, { kind: 5, tags: [["e", b.id]] }));
    expect((await count(c, [{ authors: [u.pubkey], kinds: [1] }]))[2]).toEqual({ count: 1 });
    expect((await count(c, [{ ids: [a.id, b.id] }]))[2]).toEqual({ count: 1 });
  });

  test("only the current version of a replaceable event is counted", async () => {
    const c = await conn();
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 0, content: "{}", created_at: now() - 10 }));
    await publishOk(c, sign(u.sk, { kind: 0, content: '{"name":"x"}' }));
    expect((await count(c, [{ authors: [u.pubkey], kinds: [0] }]))[2]).toEqual({ count: 1 });
  });

  test("expired events (NIP-40) stop being counted", async () => {
    const c = await conn();
    const u = newUser();
    await publishOk(c, sign(u.sk, { kind: 1, content: "short-lived", tags: [["expiration", String(now() + 2)]] }));
    expect((await count(c, [{ authors: [u.pubkey] }]))[2]).toEqual({ count: 1 });
    await Bun.sleep(3100);
    expect((await count(c, [{ authors: [u.pubkey] }]))[2]).toEqual({ count: 0 });
  });

  test("DMs the reader may not see are left out of a broad count; their recipient counts them", async () => {
    const c = await conn();
    const [alice, bob] = [newUser(), newUser()];
    await publishOk(c, sign(alice.sk, { kind: 1, content: "public 1" }));
    await publishOk(c, sign(alice.sk, { kind: 1, content: "public 2" }));
    await publishOk(c, sign(alice.sk, { kind: 4, content: "secret?iv=aaaa", tags: [["p", bob.pubkey]] }));
    expect((await count(c, [{ authors: [alice.pubkey] }]))[2]).toEqual({ count: 2 });
    const stranger = await authed(newUser().sk);
    expect((await count(stranger, [{ authors: [alice.pubkey] }]))[2]).toEqual({ count: 2 });
    const bobConn = await authed(bob.sk);
    expect((await count(bobConn, [{ authors: [alice.pubkey] }]))[2]).toEqual({ count: 3 });
  });

  test("gift wraps: counting another pubkey's is refused with CLOSED; the recipient may count their own", async () => {
    const c = await conn();
    const bob = newUser();
    const wrap = sign(newUser().sk, { kind: 1059, content: "sealed", tags: [["p", bob.pubkey]] });
    await publishOk(c, wrap);
    const anon = await count(c, [{ kinds: [1059], "#p": [bob.pubkey] }]);
    expect(anon[0]).toBe("CLOSED");
    expect(String(anon[2])).toStartWith("auth-required:");
    const stranger = await authed(newUser().sk);
    const s = await count(stranger, [{ kinds: [1059], "#p": [bob.pubkey] }]);
    expect(s[0]).toBe("CLOSED");
    expect(String(s[2])).toMatch(/^[a-z-]+: /);
    const bobConn = await authed(bob.sk);
    expect((await count(bobConn, [{ kinds: [1059], "#p": [bob.pubkey] }]))[2]).toEqual({ count: 1 });
  });

  test("COUNT with a search filter counts matches; unsupported extensions are ignored", async () => {
    const c = await staff();
    const u = newUser();
    const w = `cs${rand(5)}`;
    await publishOk(c, sign(u.sk, { kind: 1, content: `one ${w}` }));
    await publishOk(c, sign(u.sk, { kind: 1, content: `two ${w}` }));
    await publishOk(c, sign(u.sk, { kind: 1, content: "unrelated" }));
    expect((await count(c, [{ search: w, authors: [u.pubkey] }]))[2]).toEqual({ count: 2 });
    expect((await count(c, [{ search: `${w} language:en nsfw:false`, authors: [u.pubkey] }]))[2]).toEqual({ count: 2 });
  });

  test("search COUNT from a non-staff reader leaves out matching DMs it may not see", async () => {
    const c = await conn();
    const [alice, bob] = [newUser(), newUser()];
    const w = `cd${rand(5)}`;
    await publishOk(c, sign(alice.sk, { kind: 1, content: `public ${w}` }));
    await publishOk(c, sign(alice.sk, { kind: 4, content: `${w}?iv=aaaa`, tags: [["p", bob.pubkey]] }));
    expect((await count(c, [{ search: w }]))[2]).toEqual({ count: 1 });
    expect(await idsOf(c, [{ search: w }])).toHaveLength(1);
    const bobConn = await authed(bob.sk);
    expect((await count(bobConn, [{ search: w }]))[2]).toEqual({ count: 2 });
  });

  test("if an hll is returned it is 256 registers computed as the spec's algorithm describes", async () => {
    const c = await conn();
    const target = sign(newUser().sk, { kind: 1, content: "react to me" });
    await publishOk(c, target);
    const reactors = Array.from({ length: 12 }, () => newUser());
    for (const r of reactors) await publishOk(c, sign(r.sk, { kind: 7, content: "+", tags: [["e", target.id]] }));
    const filter = { kinds: [7], "#e": [target.id] };
    const m = await count(c, [filter]);
    const body = m[2] as { count: number; hll?: string };
    expect(body.count).toBe(12);
    if (body.hll !== undefined) {
      expect(body.hll).toMatch(/^[0-9a-f]{512}$/);
      expect(body.hll).toBe(hllRegisters(filter, reactors.map((r) => r.pubkey)));
    }
  });
});

// ====================================================================== NIP-50

describe("NIP-50 search", () => {
  test("each extension listed in NIP-50 is ignored rather than matched as a literal term", async () => {
    const c = await staff();
    const u = newUser();
    const w = `ex${rand(5)}`;
    const hit = await publishOk(c, sign(u.sk, { kind: 1, content: `hello ${w} world` }));
    for (const ext of ["include:spam", "domain:example.com", "language:en", "sentiment:positive", "nsfw:false", "nsfw:true"]) {
      expect(await idsOf(c, [{ search: `${w} ${ext}`, authors: [u.pubkey] }])).toEqual([hit.id]);
      expect(await idsOf(c, [{ search: `${ext} ${w}`, authors: [u.pubkey] }])).toEqual([hit.id]);
    }
    // several at once, and an unknown one
    expect(await idsOf(c, [{ search: `include:spam ${w} language:de foo:bar`, authors: [u.pubkey] }])).toEqual([hit.id]);
  });

  test("a query made only of extensions does not turn into a literal match on 'include:spam'", async () => {
    const c = await staff();
    const u = newUser();
    const a = await publishOk(c, sign(u.sk, { kind: 1, content: "first", created_at: now() - 5 }));
    const b = await publishOk(c, sign(u.sk, { kind: 1, content: "second" }));
    expect(sorted(await idsOf(c, [{ search: "include:spam", authors: [u.pubkey] }]))).toEqual(sorted([a.id, b.id]));
  });

  test("search combines with kinds, authors, since/until and tag filters (AND)", async () => {
    const c = await staff();
    const [u, v] = [newUser(), newUser()];
    const w = `cb${rand(5)}`;
    const t = now();
    const match = await publishOk(c, sign(u.sk, { kind: 1, content: `${w} match`, tags: [["t", "x"]], created_at: t - 10 }));
    await publishOk(c, sign(u.sk, { kind: 30023, content: `${w} wrong kind`, tags: [["d", "a"], ["t", "x"]], created_at: t - 10 }));
    await publishOk(c, sign(v.sk, { kind: 1, content: `${w} wrong author`, tags: [["t", "x"]], created_at: t - 10 }));
    await publishOk(c, sign(u.sk, { kind: 1, content: `${w} too old`, tags: [["t", "x"]], created_at: t - 1000 }));
    await publishOk(c, sign(u.sk, { kind: 1, content: `${w} no tag`, created_at: t - 10 }));
    expect(await idsOf(c, [{ search: w, kinds: [1], authors: [u.pubkey], since: t - 100, until: t, "#t": ["x"] }])).toEqual([match.id]);
  });

  test("several search filters in one REQ are OR'd", async () => {
    const c = await staff();
    const u = newUser();
    const [w1, w2] = [`oa${rand(5)}`, `ob${rand(5)}`];
    const a = await publishOk(c, sign(u.sk, { kind: 1, content: `${w1}` }));
    const b = await publishOk(c, sign(u.sk, { kind: 7, content: `${w2}` }));
    await publishOk(c, sign(u.sk, { kind: 1, content: `${w2} but kind 1` }));
    expect(sorted(await idsOf(c, [{ search: w1 }, { search: w2, kinds: [7] }]))).toEqual(sorted([a.id, b.id]));
  });

  test("results come in relevance order and limit is applied after ranking", async () => {
    const c = await staff();
    const u = newUser();
    const w = `rk${rand(5)}`;
    // the older event is the far better match (short, the term repeated); the newer one mentions it once in a long text
    const best = await publishOk(c, sign(u.sk, { kind: 1, content: `${w} ${w} ${w} ${w}`, created_at: now() - 3600 }));
    const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");
    const weak = await publishOk(c, sign(u.sk, { kind: 1, content: `${filler} ${w} ${filler}` }));
    expect(await idsOf(c, [{ search: w, authors: [u.pubkey] }])).toEqual([best.id, weak.id]);
    expect(await idsOf(c, [{ search: w, authors: [u.pubkey], limit: 1 }])).toEqual([best.id]);
    // an anonymous reader goes through the visibility-checked path: same order
    const anon = await conn();
    expect(await idsOf(anon, [{ search: w }])).toEqual([best.id, weak.id]);
    expect(await idsOf(anon, [{ search: w, limit: 1 }])).toEqual([best.id]);
  });
});

// ====================================================================== NIP-77

/** Independent Negentropy V1 initiator, from the NIP-77 appendix. */
namespace neg {
  export const VERSION = 0x61;
  const INF = Number.POSITIVE_INFINITY;
  type Bound = { ts: number; prefix: Uint8Array };
  export type Rec = { ts: number; id: Uint8Array };

  export function varint(n: number): number[] {
    const digits: number[] = [];
    do {
      digits.unshift(n % 128);
      n = Math.floor(n / 128);
    } while (n > 0);
    return digits.map((d, i) => (i < digits.length - 1 ? d | 0x80 : d));
  }

  class Reader {
    pos = 0;
    constructor(readonly b: Uint8Array) {}
    get done() {
      return this.pos >= this.b.length;
    }
    byte() {
      if (this.done) throw new Error("short message");
      return this.b[this.pos++];
    }
    bytes(n: number) {
      if (this.pos + n > this.b.length) throw new Error("short message");
      const out = this.b.slice(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }
    varint() {
      let n = 0;
      for (;;) {
        const b = this.byte();
        n = n * 128 + (b & 0x7f);
        if (!(b & 0x80)) return n;
      }
    }
  }

  /** sha256(sum of ids as 256-bit little-endian integers mod 2^256 || varint(count)), first 16 bytes */
  export function fingerprint(items: Rec[]): Uint8Array {
    let sum = 0n;
    for (const it of items) sum += BigInt(`0x${Buffer.from(it.id).reverse().toString("hex")}`);
    sum &= (1n << 256n) - 1n;
    const le = Buffer.from(sum.toString(16).padStart(64, "0"), "hex").reverse();
    return new Uint8Array(createHash("sha256").update(Buffer.concat([le, Buffer.from(varint(items.length))])).digest().subarray(0, 16));
  }

  function cmpBytes(a: Uint8Array, b: Uint8Array) {
    for (let i = 0; i < 32; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  /** record vs bound (prefix padded with zero bytes) */
  const cmp = (r: Rec, b: Bound) => (r.ts !== b.ts ? (r.ts < b.ts ? -1 : 1) : cmpBytes(r.id, b.prefix));

  export const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString("hex");

  export class Client {
    readonly items: Rec[];
    readonly have = new Set<string>();
    readonly need = new Set<string>();
    private lastOut = 0;
    private lastIn = 0;
    constructor(
      records: { created_at: number; id: string }[],
      private readonly idListMax = 32,
      private readonly buckets = 16,
    ) {
      this.items = records
        .map((r) => ({ ts: r.created_at, id: new Uint8Array(Buffer.from(r.id, "hex")) }))
        .sort((a, b) => a.ts - b.ts || cmpBytes(a.id, b.id));
    }

    private bound(b: Bound, out: number[]) {
      if (b.ts === INF) out.push(0);
      else {
        out.push(...varint(1 + b.ts - this.lastOut));
        this.lastOut = b.ts;
      }
      out.push(...varint(b.prefix.length), ...b.prefix);
    }

    private readBound(r: Reader): Bound {
      const t = r.varint();
      let ts: number;
      if (t === 0) ts = INF;
      else {
        ts = this.lastIn + t - 1;
        this.lastIn = ts;
      }
      const len = r.varint();
      if (len > 32) throw new Error("bound prefix too long");
      return { ts, prefix: r.bytes(len) };
    }

    private minimal(prev: Rec, curr: Rec): Bound {
      if (prev.ts !== curr.ts) return { ts: curr.ts, prefix: new Uint8Array(0) };
      let shared = 0;
      while (shared < 32 && prev.id[shared] === curr.id[shared]) shared++;
      return { ts: curr.ts, prefix: curr.id.slice(0, shared + 1) };
    }

    private split(lo: number, hi: number, upper: Bound, out: number[]) {
      const n = hi - lo;
      if (n < this.idListMax) {
        this.bound(upper, out);
        out.push(2, ...varint(n));
        for (let i = lo; i < hi; i++) out.push(...this.items[i].id);
        return;
      }
      const per = Math.floor(n / this.buckets);
      const extra = n % this.buckets;
      let cur = lo;
      for (let i = 0; i < this.buckets; i++) {
        const size = per + (i < extra ? 1 : 0);
        const fp = fingerprint(this.items.slice(cur, cur + size));
        cur += size;
        this.bound(cur === hi ? upper : this.minimal(this.items[cur - 1], this.items[cur]), out);
        out.push(1, ...fp);
      }
    }

    initiate(): string {
      this.lastOut = 0;
      const out = [VERSION];
      this.split(0, this.items.length, { ts: INF, prefix: new Uint8Array(0) }, out);
      return hex(out);
    }

    /** Processes a server message; returns the next message, or null when reconciliation is complete. */
    reconcile(msgHex: string): string | null {
      const r = new Reader(new Uint8Array(Buffer.from(msgHex, "hex")));
      this.lastIn = 0;
      this.lastOut = 0;
      const v = r.byte();
      if (v !== VERSION) throw new Error(`server protocol version 0x${v.toString(16)}`);
      const out = [VERSION];
      let prev: Bound = { ts: 0, prefix: new Uint8Array(0) };
      let prevIdx = 0;
      let skip = false;
      const flushSkip = () => {
        if (!skip) return;
        skip = false;
        this.bound(prev, out);
        out.push(0);
      };
      while (!r.done) {
        const b = this.readBound(r);
        const mode = r.varint();
        let upper = prevIdx;
        while (upper < this.items.length && cmp(this.items[upper], b) < 0) upper++;
        if (mode === 0) skip = true;
        else if (mode === 1) {
          const theirs = r.bytes(16);
          if (hex(theirs) !== hex(fingerprint(this.items.slice(prevIdx, upper)))) {
            flushSkip();
            this.split(prevIdx, upper, b, out);
          } else skip = true;
        } else if (mode === 2) {
          const k = r.varint();
          const theirs = new Set<string>();
          for (let i = 0; i < k; i++) theirs.add(hex(r.bytes(32)));
          for (let i = prevIdx; i < upper; i++) {
            const id = hex(this.items[i].id);
            if (theirs.has(id)) theirs.delete(id);
            else this.have.add(id);
          }
          for (const id of theirs) this.need.add(id);
          skip = true;
        } else throw new Error(`unknown mode ${mode}`);
        prevIdx = upper;
        prev = b;
      }
      return out.length === 1 ? null : hex(out);
    }
  }
}

const negFrame = (sub: string) => (m: Msg) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === sub;

/** Full reconciliation with the independent client. */
async function negSync(c: RelayClient, filter: Record<string, unknown>, local: { created_at: number; id: string }[] = [], opts: { sub?: string } = {}) {
  const client = new neg.Client(local);
  const sub = opts.sub ?? nextSub("neg");
  const serverMsgs: string[] = [];
  c.send(["NEG-OPEN", sub, filter, client.initiate()]);
  for (let rounds = 0; ; rounds++) {
    if (rounds > 200) throw new Error("negentropy did not converge");
    const m = await c.waitFor(negFrame(sub), 15_000);
    if (m[0] === "NEG-ERR") throw new Error(`NEG-ERR ${m[2]}`);
    serverMsgs.push(m[2] as string);
    const next = client.reconcile(m[2] as string);
    if (next === null) break;
    c.send(["NEG-MSG", sub, next]);
  }
  c.send(["NEG-CLOSE", sub]);
  return { need: sorted([...client.need]), have: sorted([...client.have]), serverMsgs };
}

/** A local-only record (never published): random id. */
const localRec = (created_at: number) => ({ created_at, id: rand(32) });

describe("NIP-77 negentropy (independent client)", () => {
  test("the client's fingerprint encoding matches a hand-computed vector", () => {
    // one id = 0x01 (as little-endian 256-bit: byte 0 = 1), count 1
    const id = new Uint8Array(32);
    id[0] = 1;
    const expected = createHash("sha256").update(Buffer.concat([Buffer.from(id), Buffer.from([1])])).digest().subarray(0, 16);
    expect(neg.hex(neg.fingerprint([{ ts: 0, id }]))).toBe(Buffer.from(expected).toString("hex"));
    expect(neg.varint(0)).toEqual([0]);
    expect(neg.varint(127)).toEqual([0x7f]);
    expect(neg.varint(128)).toEqual([0x81, 0x00]);
    expect(neg.varint(16384)).toEqual([0x81, 0x80, 0x00]);
  });

  test("unsupported protocol version: the relay replies with a single byte naming the version it supports", async () => {
    const c = await conn();
    const sub = nextSub("neg");
    // version 2 (0x62) followed by a range the relay can't be expected to parse
    c.send(["NEG-OPEN", sub, { kinds: [1], authors: [newUser().pubkey] }, "620000020000"]);
    expect(await c.waitFor(negFrame(sub))).toEqual(["NEG-MSG", sub, "61"]);
    c.send(["NEG-CLOSE", sub]);
  });

  test("empty vs empty: a single round, nothing to transfer", async () => {
    const c = await conn();
    const r = await negSync(c, { authors: [newUser().pubkey] });
    expect(r).toMatchObject({ need: [], have: [] });
    expect(r.serverMsgs.length).toBe(1);
  });

  test("empty relay set, non-empty client set: everything is reported as have", async () => {
    const c = await conn();
    const local = Array.from({ length: 50 }, (_, i) => localRec(1_700_000_000 + i));
    const r = await negSync(c, { authors: [newUser().pubkey] }, local);
    expect(r.need).toEqual([]);
    expect(r.have).toEqual(sorted(local.map((x) => x.id)));
  });

  test("disjoint sets: client needs every relay id and has every local one", async () => {
    const c = await conn();
    const u = newUser();
    const t = now() - 5000;
    const server = Array.from({ length: 40 }, (_, i) => sign(u.sk, { kind: 1, content: `d${i}`, created_at: t + i * 3 }));
    for (const e of server) await publishOk(c, e);
    const local = Array.from({ length: 45 }, (_, i) => localRec(t + i * 3 + 1));
    const r = await negSync(c, { authors: [u.pubkey] }, local);
    expect(r.need).toEqual(sorted(server.map((e) => e.id)));
    expect(r.have).toEqual(sorted(local.map((x) => x.id)));
  });

  test("identical sets of 200 ids: fingerprints match the spec algorithm, so one round with all ranges skipped", async () => {
    const author = { sk: relay.owner.sk };
    const t = now() - 20_000;
    const evs = Array.from({ length: 200 }, (_, i) => sign(author.sk, { kind: 1111, content: `same ${i} ${rand(2)}`, created_at: t + i }));
    await bulkPublish(evs);
    const c = await conn();
    const r = await negSync(c, { authors: [relay.owner.pubkey], kinds: [1111] }, evs);
    expect(r).toMatchObject({ need: [], have: [] });
    // the relay agreed with every one of the client's 16 fingerprints: its reply carries no ranges at all
    expect(r.serverMsgs).toEqual(["61"]);
  });

  test("many identical timestamps: id-prefix bounds split the ranges correctly", async () => {
    const c = await conn();
    const u = newUser();
    const ts = now() - 7777;
    const server = Array.from({ length: 120 }, (_, i) => sign(u.sk, { kind: 1, content: `same-ts ${i}`, created_at: ts }));
    for (const e of server) c.send(["EVENT", e]);
    for (const e of server) expect((await c.waitFor((m) => m[0] === "OK" && m[1] === e.id))[2]).toBe(true);
    const shared = server.filter((_, i) => i % 2 === 0);
    const localOnly = Array.from({ length: 15 }, () => localRec(ts));
    const r = await negSync(c, { authors: [u.pubkey] }, [...shared, ...localOnly]);
    expect(r.need).toEqual(sorted(server.filter((_, i) => i % 2 === 1).map((e) => e.id)));
    expect(r.have).toEqual(sorted(localOnly.map((x) => x.id)));
  });

  test("a large set (2500 ids) converges over several rounds under the relay's frame size limit", async () => {
    const t = now() - 100_000;
    const evs = Array.from({ length: 2500 }, (_, i) => sign(relay.owner.sk, { kind: 1112, content: `big ${i}`, created_at: t + i }));
    await bulkPublish(evs);
    const c = await conn();
    const local = evs.filter((_, i) => i % 7 === 0);
    const extra = Array.from({ length: 30 }, (_, i) => localRec(t + i * 50));
    const r = await negSync(c, { authors: [relay.owner.pubkey], kinds: [1112] }, [...local, ...extra]);
    expect(r.need).toEqual(sorted(evs.filter((_, i) => i % 7 !== 0).map((e) => e.id)));
    expect(r.have).toEqual(sorted(extra.map((x) => x.id)));
    // 2500 ids don't fit one 60 kB frame: several rounds, each message within the limit
    expect(r.serverMsgs.length).toBeGreaterThan(1);
    for (const m of r.serverMsgs) expect(m.length / 2).toBeLessThanOrEqual(60_000);
  }, 60_000);

  test("an empty client set against 2500 ids (one IdList range answered in frames) converges", async () => {
    const c = await conn();
    const r = await negSync(c, { authors: [relay.owner.pubkey], kinds: [1112] });
    expect(r.need.length).toBe(2500);
    expect(r.have).toEqual([]);
  }, 30_000);

  test("NEG-OPEN with the id of an open session replaces it (the new filter applies)", async () => {
    const c = await conn();
    const [a, b] = [newUser(), newUser()];
    const ea = await publishOk(c, sign(a.sk, { kind: 1, content: "a" }));
    const eb = await publishOk(c, sign(b.sk, { kind: 1, content: "b" }));
    const sub = nextSub("neg");
    // open on a, get its first reply, then reopen the same id on b and run to completion
    c.send(["NEG-OPEN", sub, { authors: [a.pubkey] }, new neg.Client([]).initiate()]);
    expect((await c.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    const r = await negSync(c, { authors: [b.pubkey] }, [], { sub });
    expect(r.need).toEqual([eb.id]);
    expect(r.need).not.toContain(ea.id);
  });

  // regression: the older NEG-OPEN's preparation could finish after the newer one's and then replace it
  test("back-to-back NEG-OPENs with one id: the session left open is the later one", async () => {
    const c = await conn();
    const [a, b, bob] = [newUser(), newUser(), newUser()];
    // a's set includes a DM this (anonymous) client can't see, so preparing a's session takes extra visibility checks
    const ea = await publishOk(c, sign(a.sk, { kind: 1, content: "a" }));
    await publishOk(c, sign(a.sk, { kind: 4, content: "dm?iv=aaaa", tags: [["p", bob.pubkey]] }));
    const eb = await publishOk(c, sign(b.sk, { kind: 1, content: "b" }));
    const sub = nextSub("neg");
    const init = new neg.Client([]).initiate();
    c.send(["NEG-OPEN", sub, { authors: [a.pubkey] }, init]);
    c.send(["NEG-OPEN", sub, { authors: [b.pubkey] }, init]);
    await Bun.sleep(500);
    for (let i = c.inbox.length - 1; i >= 0; i--) if (negFrame(sub)(c.inbox[i])) c.inbox.splice(i, 1);
    // ask the session that is now open for all of its ids (client with an empty set: IdList of 0 to infinity)
    c.send(["NEG-MSG", sub, init]);
    const m = await c.waitFor(negFrame(sub));
    expect(m[0]).toBe("NEG-MSG");
    const probe = new neg.Client([]);
    probe.reconcile(m[2] as string);
    // NIP-77: the existing subscription is closed first, so only b's session may remain
    expect([...probe.need]).toEqual([eb.id]);
    expect([...probe.need]).not.toContain(ea.id);
  });

  // regression: a NEG-CLOSE that arrived while the NEG-OPEN was still being prepared was lost; the session was
  // registered afterwards anyway (and held one of the connection's two session slots until it timed out)
  test("NEG-CLOSE right after NEG-OPEN closes the subscription (no session left behind)", async () => {
    const c = await conn();
    const [a, bob] = [newUser(), newUser()];
    await publishOk(c, sign(a.sk, { kind: 1, content: "a" }));
    await publishOk(c, sign(a.sk, { kind: 4, content: "dm?iv=aaaa", tags: [["p", bob.pubkey]] }));
    const sub = nextSub("neg");
    const init = new neg.Client([]).initiate();
    c.send(["NEG-OPEN", sub, { authors: [a.pubkey] }, init]);
    c.send(["NEG-CLOSE", sub]);
    await Bun.sleep(500);
    for (let i = c.inbox.length - 1; i >= 0; i--) if (negFrame(sub)(c.inbox[i])) c.inbox.splice(i, 1);
    c.send(["NEG-MSG", sub, init]);
    const m = await c.waitFor(negFrame(sub));
    expect(m[0]).toBe("NEG-ERR");
    expect(String(m[2])).toStartWith("closed:");
  });

  test("after NEG-ERR the subscription is closed: a following NEG-MSG gets NEG-ERR closed:", async () => {
    const c = await conn();
    const sub = nextSub("neg");
    c.send(["NEG-OPEN", sub, { authors: [newUser().pubkey] }, new neg.Client([]).initiate()]);
    expect((await c.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    // a truncated message (fingerprint mode without its 16 bytes) is an error
    c.send(["NEG-MSG", sub, "61000001"]);
    const err = await c.waitFor(negFrame(sub));
    expect(err[0]).toBe("NEG-ERR");
    expect(String(err[2])).toMatch(/^[a-z-]+: /);
    c.send(["NEG-MSG", sub, new neg.Client([]).initiate()]);
    const m = await c.waitFor(negFrame(sub));
    expect(m[0]).toBe("NEG-ERR");
    expect(String(m[2])).toStartWith("closed:");
  });

  test("NEG ids are a separate namespace from REQ ids", async () => {
    const c = await conn();
    const u = newUser();
    const sub = nextSub("both");
    await c.query(sub, [{ authors: [u.pubkey] }], false);
    c.send(["NEG-OPEN", sub, { authors: [u.pubkey] }, new neg.Client([]).initiate()]);
    expect((await c.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    c.send(["NEG-CLOSE", sub]);
    // the REQ is still live
    const writer = await conn();
    const ev = await publishOk(writer, sign(u.sk, { kind: 1, content: "live" }));
    await c.waitFor((m) => m[0] === "EVENT" && m[1] === sub && (m[2] as Event).id === ev.id);
    // and CLOSE of the REQ leaves a NEG session alone
    c.send(["NEG-OPEN", sub, { authors: [u.pubkey] }, new neg.Client([]).initiate()]);
    expect((await c.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    c.send(["CLOSE", sub]);
    c.send(["NEG-MSG", sub, new neg.Client([]).initiate()]);
    expect((await c.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    c.send(["NEG-CLOSE", sub]);
  });
});

// ====================================================================== NIP-11 / NIP-05

describe("NIP-11 document", () => {
  test("GET with Accept: application/nostr+json carries all three CORS headers NIP-11 requires", async () => {
    const res = await fetch(relay.http, { headers: { Accept: "application/nostr+json", Origin: "https://client.example" } });
    expect(res.headers.get("content-type")).toStartWith("application/nostr+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBeTruthy();
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    const pre = await fetch(relay.http, { method: "OPTIONS", headers: { Origin: "https://client.example", "Access-Control-Request-Method": "GET" } });
    expect(pre.headers.get("access-control-allow-headers")).toBeTruthy();
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("Accept lists with several media types still get the document", async () => {
    const res = await fetch(relay.http, { headers: { Accept: "text/html;q=0.9, application/nostr+json" } });
    expect(res.headers.get("content-type")).toStartWith("application/nostr+json");
  });

  test("field types: supported_nips has 45/50/77, software is a URL, self is hex, limitation values are typed", async () => {
    const doc = (await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json()) as Record<string, any>;
    for (const n of [45, 50, 77]) expect(doc.supported_nips).toContain(n);
    expect(() => new URL(doc.software)).not.toThrow();
    expect(doc.self).toMatch(/^[0-9a-f]{64}$/);
    for (const [k, v] of Object.entries(doc.limitation as Record<string, unknown>)) {
      if (["auth_required", "payment_required", "restricted_writes"].includes(k)) expect(typeof v).toBe("boolean");
      else expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("NIP-05 /.well-known/nostr.json", () => {
  test("serves names (lowercase hex) with relays, CORS and no redirect; unknown names map to nothing", async () => {
    const operator = newUser();
    await patchSettings(relay, { info: { pubkey: operator.pubkey } });
    const res = await fetch(`${relay.http}/.well-known/nostr.json?name=_`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { names: Record<string, string>; relays?: Record<string, string[]> };
    expect(body.names._).toBe(operator.pubkey);
    expect(body.relays?.[operator.pubkey]).toContain(relay.ws);
    const none = (await (await fetch(`${relay.http}/.well-known/nostr.json?name=nobody${rand(3)}`, { redirect: "manual" })).json()) as { names: object };
    expect(none.names).toEqual({});
  });
});
