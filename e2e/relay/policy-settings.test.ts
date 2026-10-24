/** Runtime settings changed through PATCH /admin/api/settings apply to the live relay (and live connections) without restart. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { finalizeEvent } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, now, sign } from "../harness/client";
import { api, getSettings, nextSub, nip11, note, ownerApi, setRole, withSettings } from "./policy-helpers";

let relay: Relay;
let c: RelayClient; // one long-lived connection: every change must reach it without reconnecting
beforeAll(async () => {
  relay = await startRelay();
  c = await RelayClient.connect(relay.ws);
});
afterAll(async () => {
  c?.close();
  await relay?.stop();
});

describe("settings API", () => {
  test("GET returns the effective defaults", async () => {
    const s = await getSettings(relay);
    expect(s.access.mode).toBe("public");
    expect(s.limits.eventsPerMinute).toBe(120);
    expect(s.moderation.kindBlocklist).toEqual([]);
  });

  test("PATCH merges deeply and persists; unknown sections and invalid values are 400", async () => {
    await withSettings(relay, { limits: { maxLimit: 321 } }, async () => {
      const s = await getSettings(relay);
      expect(s.limits.maxLimit).toBe(321);
      expect(s.limits.defaultLimit).toBe(100); // sibling untouched
    });
    expect((await api(relay, relay.owner.sk, "PATCH", "/settings", { nope: {} })).status).toBe(400);
    expect((await api(relay, relay.owner.sk, "PATCH", "/settings", { limits: { maxLimit: 0 } })).status).toBe(400);
    expect((await api(relay, relay.owner.sk, "PATCH", "/settings", { access: { mode: "everyone" } })).status).toBe(400);
    expect((await getSettings(relay)).access.mode).toBe("public");
  });

  test("non-admins cannot read or change settings; a viewer can read but not change", async () => {
    const stranger = newUser();
    expect([401, 403]).toContain((await api(relay, stranger.sk, "PATCH", "/settings", { limits: { maxLimit: 5 } })).status);
    expect((await api(relay, null, "GET", "/settings")).status).toBe(401);
    const viewer = newUser();
    await setRole(relay, viewer.pubkey, "viewer");
    expect((await api(relay, viewer.sk, "GET", "/settings")).status).toBe(200);
    expect((await api(relay, viewer.sk, "PATCH", "/settings", { limits: { maxLimit: 5 } })).status).toBe(403);
    expect((await getSettings(relay)).limits.maxLimit).toBe(500);
  });
});

describe("limits take effect live", () => {
  test("maxContentLength", async () => {
    const u = newUser();
    await withSettings(relay, { limits: { maxContentLength: 10 } }, async () => {
      expect(await c.publish(note(u.sk, "x".repeat(11)))).toEqual({ ok: false, message: "invalid: content is too long (max 10)" });
      expect((await c.publish(note(u.sk, "ok"))).ok).toBe(true);
    });
    expect((await c.publish(note(u.sk, "x".repeat(11)))).ok).toBe(true);
  });

  test("maxEventTags", async () => {
    const u = newUser();
    await withSettings(relay, { limits: { maxEventTags: 2 } }, async () => {
      const ev = note(u.sk, "tags", { tags: [["t", "a"], ["t", "b"], ["t", "c"]] });
      expect(await c.publish(ev)).toEqual({ ok: false, message: "invalid: too many tags (max 2)" });
    });
  });

  test("minPowDifficulty: low-difficulty events get pow:, mined ones pass", async () => {
    const u = newUser();
    await withSettings(relay, { limits: { minPowDifficulty: 8 } }, async () => {
      // an id that starts with a non-zero nibble has difficulty < 8
      let weak = note(u.sk);
      while (weak.id.startsWith("0")) weak = note(u.sk);
      const r = await c.publish(weak);
      expect(r.ok).toBe(false);
      expect(r.message).toStartWith("pow: difficulty");
      let mined;
      const created_at = now();
      for (let n = 0; ; n++) {
        mined = finalizeEvent({ kind: 1, created_at, content: "mined", tags: [["nonce", String(n), "8"]] }, u.sk);
        if (mined.id.startsWith("00")) break;
      }
      expect((await c.publish(mined)).ok).toBe(true);
    });
    expect((await nip11(relay)).limitation.min_pow_difficulty).toBe(0);
  });

  test("createdAtLowerSec / createdAtUpperSec", async () => {
    const u = newUser();
    await withSettings(relay, { limits: { createdAtLowerSec: 3600, createdAtUpperSec: 60 } }, async () => {
      expect((await c.publish(note(u.sk, "old", { created_at: now() - 7200 }))).message).toBe("invalid: created_at is too far in the past");
      expect((await c.publish(note(u.sk, "future", { created_at: now() + 600 }))).message).toBe("invalid: created_at is too far in the future");
      expect((await c.publish(note(u.sk, "recent", { created_at: now() - 60 }))).ok).toBe(true);
      expect((await nip11(relay)).limitation.created_at_lower_limit).toBe(3600);
    });
  });

  test("maxLimit and defaultLimit cap REQ results", async () => {
    const u = newUser();
    for (let i = 0; i < 5; i++) expect((await c.publish(note(u.sk, `n${i}`, { created_at: now() - i }))).ok).toBe(true);
    await withSettings(relay, { limits: { maxLimit: 3, defaultLimit: 2 } }, async () => {
      expect((await c.query(nextSub(), [{ authors: [u.pubkey], limit: 10 }])).events.length).toBe(3);
      expect((await c.query(nextSub(), [{ authors: [u.pubkey] }])).events.length).toBe(2);
    });
    expect((await c.query(nextSub(), [{ authors: [u.pubkey] }])).events.length).toBe(5);
  });

  test("maxFilters", async () => {
    await withSettings(relay, { limits: { maxFilters: 2 } }, async () => {
      const q = await c.query(nextSub(), [{ kinds: [1], limit: 1 }, { kinds: [2], limit: 1 }, { kinds: [3], limit: 1 }]);
      expect(q.closed).toBe("invalid: too many filters (max 2)");
    });
  });

  test("maxMessageBytes", async () => {
    const u = newUser();
    await withSettings(relay, { limits: { maxMessageBytes: 2000 } }, async () => {
      const ev = note(u.sk, "y".repeat(3000));
      const r = await c.publish(ev);
      expect(r.ok).toBe(false);
      expect(r.message).toBe("invalid: message too large (max 2000 bytes)");
      expect((await nip11(relay)).limitation.max_message_length).toBe(2000);
    });
  });
});

describe("raising limits at runtime", () => {
  test("raising maxMessageBytes / maxEventBytes / maxContentLength admits a larger event on an existing connection", async () => {
    const u = newUser();
    const big = note(u.sk, "z".repeat(200_000));
    const before = await c.publish(big);
    expect(before.ok).toBe(false);
    expect(before.message).toStartWith("invalid: message too large");
    await withSettings(relay, { limits: { maxMessageBytes: 400_000, maxEventBytes: 400_000, maxContentLength: 300_000 } }, async () => {
      expect(await c.publish(big)).toEqual({ ok: true, message: "" });
      // and on a fresh connection
      const fresh = await RelayClient.connect(relay.ws);
      const big2 = note(u.sk, "w".repeat(200_000));
      expect((await fresh.publish(big2)).ok).toBe(true);
      fresh.close();
    });
    expect(c.closed).toBe(false);
  });
});

describe("other sections take effect live", () => {
  test("info.name / info.description are served in NIP-11", async () => {
    await withSettings(relay, { info: { name: "e2e relay name", description: "set at runtime" } }, async () => {
      const d = await nip11(relay);
      expect(d.name).toBe("e2e relay name");
      expect(d.description).toBe("set at runtime");
    });
    expect((await nip11(relay)).name).toBe("beamhop relay");
  });

  test("groups.enabled=false refuses NIP-29 control events and drops 29 from NIP-11", async () => {
    const u = newUser();
    expect((await nip11(relay)).supported_nips).toContain(29);
    await withSettings(relay, { groups: { enabled: false } }, async () => {
      const create = sign(u.sk, { kind: 9007, tags: [["h", `g${Date.now()}`]] });
      expect(await c.publish(create)).toEqual({ ok: false, message: "restricted: groups are disabled on this relay" });
      expect((await nip11(relay)).supported_nips).not.toContain(29);
    });
  });

  test("access.mode switches from public to whitelist and back on the same connection", async () => {
    const u = newUser();
    await withSettings(relay, { access: { mode: "whitelist" } }, async () => {
      expect((await c.publish(note(u.sk))).message).toStartWith("restricted:");
    });
    expect((await c.publish(note(u.sk))).ok).toBe(true);
  });
});
