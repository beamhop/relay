/**
 * Unicode round trips: content and tags must come back code-point exact (no normalization, no re-encoding), ids must
 * still verify against the canonical NIP-01 serialization, tag filters match exact code points, and \u-escaped
 * frames from clients are accepted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getEventHash, verifyEvent, type Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser, sign } from "../harness/client";
import { clients, plain, rand, sendRaw, startCoreRelay } from "./core-helpers";

let relay: Relay;
const pool = clients();
let c: RelayClient;
beforeAll(async () => {
  relay = await startCoreRelay();
  c = await pool.connect(relay.ws);
});
afterAll(async () => {
  pool.closeAll();
  await relay?.stop();
});

const SAMPLES: [string, string][] = [
  ["emoji ZWJ sequence + skin tone + flag", "family 👨‍👩‍👧‍👦 wave 👋🏽 flag 🇹🇷 rocket 🚀"],
  ["NFC precomposed", "café"],
  ["NFD decomposed", "café"],
  ["RTL with marks", "‏שלום עולם‎ مرحبا"],
  ["zero-width chars and BOM", "a​b‌c‍d﻿e"],
  ["line/paragraph separators", "one two three"],
  ["CJK + astral math + max code point", "漢字かなカナ 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 \u{10FFFF}"],
  ["C0 controls that NIP-01 escapes", "tab\tnl\ncr\rbs\bff\f bell\u0007 unit\u001f"],
  ["quotes, backslashes, markup", `"quoted" \\back\\slash </script><b>&amp;`],
  ["noncharacters mid-string", "a\ufffeb\uffffc"],
  ["BOM mid-string", "a\ufeffb"],
];

describe("content round trip", () => {
  for (const [name, content] of SAMPLES) {
    test(`${name}: stored and returned code-point exact, id re-verifies`, async () => {
      const u = newUser();
      const ev = sign(u.sk, { kind: 1, content, tags: [["t", content], ["alt", `${content} alt`]] });
      expect(await c.publish(ev)).toEqual({ ok: true, message: "" });
      const { events } = await c.query(`u-${rand(4)}`, [{ ids: [ev.id] }]);
      expect(events.length).toBe(1);
      const got = events[0];
      expect(got.content).toBe(content);
      expect([...got.content].map((ch) => ch.codePointAt(0))).toEqual([...content].map((ch) => ch.codePointAt(0)));
      expect(got.tags).toEqual(ev.tags);
      expect(getEventHash(got)).toBe(ev.id);
      expect(verifyEvent(plain(got) as Event)).toBe(true);
    });
  }

  // regression: bun:sqlite binds strings as UTF-16 and SQLite dropped a leading byte-order mark (U+FEFF / U+FFFE),
  // so the served event no longer matched its id/signature
  test("content starting with U+FEFF or U+FFFE round-trips byte-exact", async () => {
    for (const content of ["\ufeffstarts with a BOM", "\ufffestarts with a reversed BOM"]) {
      const u = newUser();
      const ev = sign(u.sk, { kind: 1, content });
      expect(await c.publish(ev)).toEqual({ ok: true, message: "" });
      const { events } = await c.query(`bom-${rand(4)}`, [{ ids: [ev.id] }]);
      expect(events[0].content).toBe(content);
      expect(getEventHash(events[0])).toBe(ev.id);
    }
  });

  test("NFC and NFD spellings are distinct events and each tag filter matches only its own spelling", async () => {
    const u = newUser();
    const nfc = sign(u.sk, { kind: 1, content: "nfc", tags: [["t", "café"]] });
    const nfd = sign(u.sk, { kind: 1, content: "nfd", tags: [["t", "café"]] });
    await c.publish(nfc);
    await c.publish(nfd);
    expect((await c.query("nfc", [{ authors: [u.pubkey], "#t": ["café"] }])).events.map((e) => e.id)).toEqual([nfc.id]);
    expect((await c.query("nfd", [{ authors: [u.pubkey], "#t": ["café"] }])).events.map((e) => e.id)).toEqual([nfd.id]);
  });

  test("emoji tag values match in stored queries and live delivery", async () => {
    const u = newUser();
    const tag = `🚀${rand(3)}🌕`;
    const watcher = await pool.connect(relay.ws);
    watcher.send(["REQ", "emoji-live", { "#t": [tag] }]);
    await watcher.waitFor((m) => m[0] === "EOSE" && m[1] === "emoji-live");
    const ev = sign(u.sk, { kind: 1, content: "to the moon 🚀🌕", tags: [["t", tag]] });
    await c.publish(ev);
    const live = await watcher.waitFor((m) => m[0] === "EVENT" && m[1] === "emoji-live");
    expect((live[2] as Event).content).toBe(ev.content);
    expect((await c.query("emoji-stored", [{ "#t": [tag] }])).events.map((e) => e.id)).toEqual([ev.id]);
  });

  test("kind 0 metadata JSON with emoji and escapes survives as the same string", async () => {
    const u = newUser();
    const meta = JSON.stringify({ name: "Ünïcødé 🦄", about: "line1\nline2 \"q\"  ", display_name: "テスト" });
    const ev = sign(u.sk, { kind: 0, content: meta });
    await c.publish(ev);
    const { events } = await c.query("meta", [{ kinds: [0], authors: [u.pubkey] }]);
    expect(events[0].content).toBe(meta);
    expect(JSON.parse(events[0].content).name).toBe("Ünïcødé 🦄");
  });

  test("a frame that \\u-escapes every non-ASCII character is accepted and stored as the decoded text", async () => {
    const u = newUser();
    const content = "escaped é ✓ 🚀 שלום";
    const ev = sign(u.sk, { kind: 1, content, tags: [["t", "✓"]] });
    const asciiOnly = JSON.stringify(["EVENT", ev]).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect(/[^\x00-\x7f]/.test(asciiOnly)).toBe(false);
    sendRaw(c, asciiOnly);
    const ok = await c.waitFor((m) => m[0] === "OK" && m[1] === ev.id);
    expect(ok[2]).toBe(true);
    const { events } = await c.query("esc", [{ ids: [ev.id] }]);
    expect(events[0].content).toBe(content);
  });

  test("a long mixed astral/BMP string keeps its code-point and UTF-16 lengths", async () => {
    const u = newUser();
    const content = "🙂".repeat(5000) + "é".repeat(5000);
    const ev = sign(u.sk, { kind: 1, content });
    expect((await c.publish(ev)).ok).toBe(true);
    const { events } = await c.query("len", [{ ids: [ev.id] }]);
    expect([...events[0].content].length).toBe(10_000);
    expect(events[0].content.length).toBe(15_000);
  });
});

describe("malformed unicode", () => {
  // The id covers JSON.stringify's "\ud800" escape, but content is bound to SQLite as a raw string: bun:sqlite turns
  // "\ud800 " into U+10020, better-sqlite3 (Node) into U+FFFD. Either way the served event no longer hashes to its id.
  // Tags are JSON-encoded and survive. Fix: refuse lone surrogates as invalid: (they are not valid UTF-8 text).
  test("a lone surrogate in content is refused as invalid (regression: it used to be stored corrupted)", async () => {
    const u = newUser();
    const ev = sign(u.sk, { kind: 1, content: `lone \ud800 surrogate ${rand(3)}` });
    c.send(["EVENT", ev]);
    const ok = await c.waitFor((m) => m[0] === "OK" && m[1] === ev.id);
    expect(ok[2]).toBe(false);
    expect(String(ok[3])).toStartWith("invalid:");
    // the connection is still usable
    expect((await c.publish(sign(u.sk, { kind: 1, content: "after lone surrogate" }))).ok).toBe(true);
  });

  // the tag index stores values as text, where a lone surrogate can't survive either: refused like content
  test("a lone surrogate in a tag value is refused as invalid and the connection stays usable", async () => {
    const u = newUser();
    const ev = sign(u.sk, { kind: 1, content: "tag-surrogate", tags: [["t", `x\ud800y${rand(2)}`]] });
    const r = await c.publish(ev);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("invalid:");
    expect((await c.publish(sign(u.sk, { kind: 1, content: "after tag surrogate" }))).ok).toBe(true);
  });

  test("invalid UTF-8 bytes in a binary frame do not kill the connection", async () => {
    const u = newUser();
    const ev = sign(u.sk, { kind: 1, content: "binary-frame" });
    const bytes = Buffer.concat([Buffer.from(JSON.stringify(["EVENT", ev]).slice(0, -2)), Buffer.from([0xff, 0xfe]), Buffer.from("]]")]);
    c.ws.send(bytes);
    await Bun.sleep(150);
    expect(c.closed).toBe(false);
    expect((await c.publish(sign(u.sk, { kind: 1, content: "after binary" }))).ok).toBe(true);
  });
});
