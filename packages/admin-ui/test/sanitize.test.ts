import { describe, expect, test } from "bun:test";
import { parseFiltersParam, parseProfileContent, repostContent, sanitizeFilter } from "../src/lib/sanitize";
import { displayName } from "../src/lib/nostr";

const PK = "a".repeat(64);

describe("parseProfileContent (kind-0 content)", () => {
  test("keeps string fields", () => {
    const p = parseProfileContent(JSON.stringify({ name: "alice", display_name: "Alice", picture: "https://x/p.png", about: "hi", nip05: "a@b.c", website: "https://a.b" }));
    expect(p).toEqual({ name: "alice", display_name: "Alice", picture: "https://x/p.png", about: "hi", nip05: "a@b.c", website: "https://a.b" });
  });

  // each of these crashed the Events / Reports pages (displayName's .trim, or "Objects are not valid as a React child")
  test.each([
    ["object name", '{"name":{"x":1}}'],
    ["number display_name", '{"display_name":1}'],
    ["array about", '{"about":["a"]}'],
    ["null", "null"],
    ["number", "1"],
    ["string", '"alice"'],
    ["array", '[{"name":"x"}]'],
    ["invalid json", "{name"],
    ["empty", ""],
  ])("crafted content (%s) yields string fields only", (_label, content) => {
    const p = parseProfileContent(content);
    for (const v of Object.values(p)) expect(typeof v).toBe("string");
    expect(() => displayName(PK, p)).not.toThrow();
  });

  test("drops non-string fields but keeps the rest", () => {
    expect(parseProfileContent('{"name":{"x":1},"about":"ok","picture":5}')).toEqual({ about: "ok" });
  });

  test("displayName fallback and length cap", () => {
    expect(parseProfileContent('{"displayName":"Bob"}').display_name).toBe("Bob");
    expect(parseProfileContent(JSON.stringify({ about: "x".repeat(5000) })).about).toHaveLength(2000);
  });
});

describe("repostContent (kind 6/16)", () => {
  test("returns the embedded event's string content", () => {
    expect(repostContent(JSON.stringify({ content: "hello", kind: 1 }))).toBe("hello");
  });

  test.each([["number", '{"content":1}'], ["array", '{"content":["a"]}'], ["object", '{"content":{}}'], ["null", "null"], ["bad json", "{"], ["empty", ""]])(
    "non-string content (%s) is ignored",
    (_l, c) => {
      expect(repostContent(c)).toBeUndefined();
    },
  );
});

describe("filters from ?f= links", () => {
  test("keeps well-typed fields", () => {
    expect(sanitizeFilter({ kinds: [1, 7], authors: [PK], "#t": ["nostr"], since: 10, search: "x", limit: 5 })).toEqual({
      kinds: [1, 7],
      authors: [PK],
      "#t": ["nostr"],
      since: 10,
      search: "x",
      limit: 5,
    });
  });

  test("drops wrongly typed fields", () => {
    expect(sanitizeFilter({ kinds: "1", authors: [1], ids: {}, since: "now", search: 1, "#t": "x", "#long": ["a"] })).toEqual({});
  });

  test("parses objects and arrays, falls back to the empty filter", () => {
    expect(parseFiltersParam('{"kinds":[1]}')).toEqual([{ kinds: [1] }]);
    expect(parseFiltersParam('[{"kinds":[1]},5,null,{"ids":["x"]}]')).toEqual([{ kinds: [1] }, { ids: ["x"] }]);
    expect(parseFiltersParam("not json")).toEqual([{}]);
    expect(parseFiltersParam("[1,2]")).toEqual([{}]);
    expect(parseFiltersParam(undefined)).toEqual([{}]);
  });
});
