/**
 * Graceful shutdown and restart on the same data dir: open subscriptions are told and closed cleanly, events
 * acknowledged before the stop are durable, in-flight writes never produce a false OK, and an upload cut off by the
 * shutdown leaves no blob, descriptor or temp file behind.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey } from "nostr-tools";
import { RelayClient, newUser, sha256, sign } from "../harness/client";
import { bauth, upload } from "./admin-helpers";
import { RELAXED_LIMITS } from "./core-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

async function relaxed(r: GapRelay) {
  const { api } = await import("./admin-helpers");
  const s = await api(r.http, r.owner.sk, "PATCH", "/settings", { limits: RELAXED_LIMITS, blossom: { uploadAccess: "anyone" } });
  if (s.status !== 200) throw new Error(`settings ${s.status}`);
}

async function until(pred: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

describe("graceful stop", () => {
  test("20 clients with open subscriptions (some authed, one mid-REQ) all get the NOTICE and close 1001", async () => {
    const r = await bootGap();
    await relaxed(r);
    const cs = await Promise.all(Array.from({ length: 20 }, () => RelayClient.connect(r.ws)));
    for (const [i, c] of cs.entries()) {
      if (i % 2) await c.auth(newUser().sk, r.ws);
      c.send(["REQ", `s${i}`, { kinds: [1] }, { "#t": [`t${i}`] }]);
    }
    await Promise.all(cs.map((c, i) => c.waitFor((m) => m[0] === "EOSE" && m[1] === `s${i}`)));
    cs[0].send(["REQ", "late", { kinds: [1], limit: 500 }]); // possibly still running when the stop lands
    await r.stop();
    await until(() => cs.every((c) => c.closed));
    for (const c of cs) {
      expect(c.closeCode).toBe(1001);
      expect(c.inbox).toContainEqual(["NOTICE", "error: relay is shutting down"]);
    }
  });

  test("HTTP after stop is refused (connection error), not answered by a half-stopped server", async () => {
    const r = await bootGap();
    await r.stop();
    await expect(fetch(`${r.http}/health`)).rejects.toThrow();
  });
});

describe("durability across a restart", () => {
  test("every event acknowledged with OK true before the stop is served after a restart on the same dir", async () => {
    const ownerSk = generateSecretKey();
    const first = await bootGap({ ownerSk });
    await relaxed(first);
    const c = await RelayClient.connect(first.ws);
    const u = newUser();
    const evs = Array.from({ length: 60 }, (_, i) => sign(u.sk, { kind: 1, content: `durable ${i}`, created_at: Math.floor(Date.now() / 1000) - i }));
    const oks = await Promise.all(evs.map((e) => c.publish(e)));
    expect(oks.every((o) => o.ok)).toBe(true);
    // a replaceable update and a deletion, acknowledged right before the stop
    const meta = sign(u.sk, { kind: 0, content: '{"name":"before restart"}' });
    expect((await c.publish(meta)).ok).toBe(true);
    const del = sign(u.sk, { kind: 5, tags: [["e", evs[0].id]] });
    expect((await c.publish(del)).ok).toBe(true);
    await first.stop(false);

    const second = await bootGap({ dir: first.dir, ownerSk });
    try {
      const c2 = await RelayClient.connect(second.ws);
      const { events } = await c2.query("all", [{ authors: [u.pubkey], kinds: [1], limit: 500 }]);
      expect(events.map((e) => e.id).sort()).toEqual(evs.slice(1).map((e) => e.id).sort());
      expect((await c2.query("meta", [{ authors: [u.pubkey], kinds: [0] }])).events.map((e) => e.id)).toEqual([meta.id]);
      // the deleted event stays deleted: re-publishing it is refused
      expect((await c2.publish(evs[0])).ok).toBe(false);
      c2.close();
    } finally {
      await second.stop();
    }
  });

  test("EVENTs in flight when the stop lands: no OK true is ever sent for an event that is not stored", async () => {
    const ownerSk = generateSecretKey();
    const first = await bootGap({ ownerSk });
    await relaxed(first);
    const c = await RelayClient.connect(first.ws);
    const u = newUser();
    const evs = Array.from({ length: 200 }, (_, i) => sign(u.sk, { kind: 1, content: `inflight ${i} ${Math.random()}` }));
    for (const e of evs) c.send(["EVENT", e]);
    await until(() => c.inbox.some((m) => m[0] === "OK"));
    await first.stop(false);
    await until(() => c.closed);
    const acked = new Set(c.inbox.filter((m) => m[0] === "OK" && m[2] === true).map((m) => m[1] as string));
    expect(acked.size).toBeGreaterThan(0);

    const second = await bootGap({ dir: first.dir, ownerSk });
    try {
      const c2 = await RelayClient.connect(second.ws);
      const stored = new Set((await c2.query("all", [{ authors: [u.pubkey], limit: 500 }])).events.map((e) => e.id));
      for (const id of acked) expect(stored.has(id)).toBe(true);
      c2.close();
    } finally {
      await second.stop();
    }
  });

  test("an upload cut off by the shutdown leaves no blob, descriptor or temp file; the same blob uploads fine after restart", async () => {
    const ownerSk = generateSecretKey();
    const first = await bootGap({ ownerSk });
    await relaxed(first);
    const u = newUser();
    const bytes = new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2 * 1024 * 1024, 7), Buffer.from(`\n%${Math.random()}\n%%EOF\n`)]));
    const sha = sha256(bytes);
    let sent = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (sent >= bytes.byteLength) return ctrl.close();
        if (sent >= bytes.byteLength / 2) await gate; // stall halfway until the relay is stopping
        const chunk = bytes.subarray(sent, Math.min(sent + 64 * 1024, bytes.byteLength));
        sent += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
    });
    const req = fetch(`${first.http}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.byteLength), Authorization: bauth(u.sk, "upload", { hashes: [sha] }) },
      body,
      duplex: "half",
    } as RequestInit).then(
      (res) => res.status,
      () => "error" as const,
    );
    await until(() => sent >= bytes.byteLength / 2);
    const stopping = first.stop(false);
    release();
    const outcome = await req;
    await stopping;
    // the upload must not have been reported as stored
    expect(outcome === "error" || (typeof outcome === "number" && outcome >= 400)).toBe(true);
    const leftovers = walk(join(first.dir, "blobs"));
    expect(leftovers.filter((p) => p.endsWith(".tmp"))).toEqual([]);
    expect(leftovers.filter((p) => p.includes(sha))).toEqual([]);

    const second = await bootGap({ dir: first.dir, ownerSk });
    try {
      await relaxed(second);
      expect((await fetch(`${second.http}/${sha}`)).status).toBe(404);
      const list = await fetch(`${second.http}/list/${u.pubkey}`, { headers: { Authorization: bauth(u.sk, "list") } });
      expect((await list.json()).map((d: { sha256: string }) => d.sha256)).not.toContain(sha);
      const again = await upload(second.http, u.sk, bytes, { type: "application/pdf" });
      expect(again.status).toBe(201);
      const got = await fetch(`${second.http}/${sha}`);
      expect(sha256(new Uint8Array(await got.arrayBuffer()))).toBe(sha);
    } finally {
      await second.stop();
    }
  }, 30_000);
});
