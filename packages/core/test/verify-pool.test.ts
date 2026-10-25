import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { Verifier } from "../src/pipeline/verify";
import { VerifyPool, verifyWorkerUrl } from "../src/pipeline/verify-pool";
import { keypair, setup, sign } from "./fakes";

const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
const args = (e: NostrEvent) => [e.id, e.pubkey, e.sig] as const;

describe("VerifyPool", () => {
  test("verifies on workers, in batches spread over them", async () => {
    const pool = new VerifyPool(2);
    try {
      const kp = keypair();
      const evs = Array.from({ length: 40 }, (_, i) => sign(kp, { content: `n${i}` }));
      const ok = await Promise.all(evs.map((e) => pool.verify(...args(e))));
      expect(ok.every(Boolean)).toBe(true);
      expect(pool.workers).toBe(2);
      const bad = await Promise.all([
        pool.verify(evs[0].id, evs[0].pubkey, flip(evs[0].sig)),
        pool.verify(evs[0].id, keypair().pk, evs[0].sig),
        pool.verify(evs[0].id, evs[0].pubkey, "zz".repeat(64)),
        pool.verify("not hex", evs[0].pubkey, evs[0].sig),
      ]);
      expect(bad).toEqual([false, false, false, false]);
    } finally {
      await pool.close();
    }
  });

  test("without a worker script, verifies on the main thread", async () => {
    const pool = new VerifyPool(2, null);
    const e = sign(keypair());
    expect(await pool.verify(...args(e))).toBe(true);
    expect(await pool.verify(e.id, e.pubkey, flip(e.sig))).toBe(false);
    expect(pool.workers).toBe(0);
  });

  test("a worker dying with batches in flight: they're verified on the main thread", async () => {
    const errors: string[] = [];
    const pool = new VerifyPool(1, new URL("./fixtures/dying-worker.ts", import.meta.url), (msg) => errors.push(msg));
    const kp = keypair();
    const good = sign(kp);
    const forged = { ...sign(kp), sig: flip(good.sig) };
    expect(await Promise.all([pool.verify(...args(good)), pool.verify(...args(forged))])).toEqual([true, false]);
    expect(errors[0]).toMatch(/worker died/);
    // after MAX_WORKER_FAILURES deaths the pool stops starting workers
    for (let i = 0; i < 6; i++) expect(await pool.verify(...args(good))).toBe(true);
    expect(errors.at(-1)).toMatch(/main thread from now on/);
    expect(pool.workers).toBe(0);
  });

  test("after close(), verification continues on the main thread", async () => {
    const pool = new VerifyPool(1);
    const e = sign(keypair());
    expect(await pool.verify(...args(e))).toBe(true);
    await pool.close();
    expect(await pool.verify(...args(e))).toBe(true);
  });

  test("the worker script is found next to the module when running from source", () => {
    expect(String(verifyWorkerUrl())).toMatch(/verify-worker\.ts$/);
  });
});

describe("Verifier.check (pool)", () => {
  test("same verdicts as verify(): a cached (id, sig) can't be reused with another pubkey or body", async () => {
    const pool = new VerifyPool(1);
    try {
      const v = new Verifier(100, pool);
      const ev = sign(keypair());
      expect(await v.check(ev)).toBe(true);
      expect(await v.check(ev)).toBe(true);
      expect(await v.check({ ...ev, pubkey: keypair().pk })).toBe(false);
      expect(await v.check({ ...ev, content: "forged" })).toBe(false);
      expect(await v.check({ ...ev, sig: flip(ev.sig) })).toBe(false);
    } finally {
      await pool.close();
    }
  });

  test("concurrent checks of one event verify its signature once; prefetch() is joined by a later check", async () => {
    const calls: string[] = [];
    const pool = new VerifyPool(1, null);
    const verify = pool.verify.bind(pool);
    pool.verify = (id, pk, sig) => {
      calls.push(id);
      return verify(id, pk, sig);
    };
    const v = new Verifier(100, pool);
    const a = sign(keypair());
    expect(await Promise.all([v.check(a), v.check({ ...a }), v.check({ ...a })])).toEqual([true, true, true]);
    const b = sign(keypair());
    v.prefetch(b);
    expect(await v.check(b)).toBe(true);
    expect(calls).toEqual([a.id, b.id]);
  });

  test("without a pool, prefetch() does nothing and check() verifies in place", async () => {
    const v = new Verifier();
    const e = sign(keypair());
    v.prefetch(e);
    expect(await v.check(e)).toBe(true);
    expect(await v.check({ ...e, sig: flip(e.sig) })).toBe(false);
  });
});

describe("EVENT pipeline with the shared pool", () => {
  test("valid events are accepted, a forged signature is refused", async () => {
    const { connect } = await setup({ config: { server: { publicUrl: "https://relay.example.com", verifyWorkers: 2 } } });
    const c = connect();
    const kp = keypair();
    const evs = Array.from({ length: 10 }, (_, i) => sign(kp, { content: `n${i}` }));
    const forged = { ...sign(kp), sig: flip(evs[0].sig) };
    const res = await Promise.all([...evs, forged].map((e) => c.publish(e)));
    expect(res.slice(0, 10).every((r) => r[2] === true)).toBe(true);
    expect(res[10][2]).toBe(false);
    expect(res[10][3]).toMatch(/^invalid: bad event id or signature/);
  });
});
