import { describe, expect, test } from "bun:test";
import { Relay, type RelayServer } from "../../src/relay.ts";
import { nip05, buildDirectory } from "../../src/plugins/nip05.ts";

const NAMES = {
  alice: "a".repeat(64),
  Bob: "b".repeat(64),
};
const RELAYS = { ["a".repeat(64)]: ["wss://relay.example.com"] };

function relay(withRelays = false) {
  const r = new Relay({ name: "t" });
  r.use(nip05({ names: NAMES, relays: withRelays ? RELAYS : undefined }));
  r.install();
  return r;
}

async function get(r: Relay, path: string) {
  const server = { upgrade: () => false } as unknown as RelayServer;
  return r.fetch(new Request(`http://localhost${path}`), server);
}

describe("buildDirectory", () => {
  test("returns a single matched name (case-insensitive)", () => {
    expect(buildDirectory({ names: NAMES }, "ALICE")).toEqual({
      names: { ALICE: "a".repeat(64) },
    });
  });

  test("unknown name yields empty names", () => {
    expect(buildDirectory({ names: NAMES }, "carol")).toEqual({ names: {} });
  });

  test("no name returns the full directory", () => {
    expect(buildDirectory({ names: NAMES }, null)).toEqual({ names: NAMES });
  });

  test("includes relays only for returned pubkeys", () => {
    const out = buildDirectory({ names: NAMES, relays: RELAYS }, "alice");
    expect(out.relays).toEqual(RELAYS);
    const none = buildDirectory({ names: NAMES, relays: RELAYS }, "Bob");
    expect(none.relays).toEqual({}); // Bob has no relay entry
  });
});

describe("NIP-05 endpoint", () => {
  test("serves a name lookup with CORS", async () => {
    const res = await get(relay(), "/.well-known/nostr.json?name=alice");
    expect(res!.status).toBe(200);
    expect(res!.headers.get("access-control-allow-origin")).toBe("*");
    expect(res!.headers.get("content-type")).toBe("application/json");
    const body = (await res!.json()) as { names: Record<string, string> };
    expect(body.names.alice).toBe("a".repeat(64));
  });

  test("serves relays when configured", async () => {
    const res = await get(relay(true), "/.well-known/nostr.json?name=alice");
    const body = (await res!.json()) as { relays: Record<string, string[]> };
    expect(body.relays["a".repeat(64)]).toEqual(["wss://relay.example.com"]);
  });

  test("unknown name returns 200 with empty names", async () => {
    const res = await get(relay(), "/.well-known/nostr.json?name=nobody");
    const body = (await res!.json()) as { names: Record<string, string> };
    expect(res!.status).toBe(200);
    expect(body.names).toEqual({});
  });

  test("OPTIONS preflight on the well-known path returns 204", async () => {
    const server = { upgrade: () => false } as unknown as RelayServer;
    const res = await relay().fetch(
      new Request("http://localhost/.well-known/nostr.json", { method: "OPTIONS" }),
      server,
    );
    expect(res!.status).toBe(204);
    expect(res!.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("non-GET on the well-known path falls through (426)", async () => {
    const server = { upgrade: () => false } as unknown as RelayServer;
    const res = await relay().fetch(
      new Request("http://localhost/.well-known/nostr.json", { method: "POST" }),
      server,
    );
    expect(res!.status).toBe(426);
  });

  test("unrelated path falls through to the upgrade (426)", async () => {
    const res = await get(relay(), "/somewhere/else");
    expect(res!.status).toBe(426);
  });
});
