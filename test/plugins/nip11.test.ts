import { describe, expect, test } from "bun:test";
import { createRelay } from "../../src/server.ts";
import type { RelayServer } from "../../src/relay.ts";

function relay() {
  const r = createRelay({ name: "info-relay", software: "sw", version: "9" });
  r.install();
  return r;
}

async function route(r: ReturnType<typeof relay>, req: Request) {
  // Drive the NIP-11 route directly via the relay's fetch, with a stub server
  // whose upgrade always fails so non-NIP-11 requests fall through to 426.
  const server = { upgrade: () => false } as unknown as RelayServer;
  return r.fetch(req, server);
}

describe("nip11 relay info document", () => {
  test("serves JSON when Accept is application/nostr+json", async () => {
    const res = await route(
      relay(),
      new Request("http://localhost/", { headers: { Accept: "application/nostr+json" } }),
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("application/nostr+json");
    expect(res!.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.name).toBe("info-relay");
    expect(body.supported_nips).toEqual([
      1, 2, 3, 4, 9, 11, 12, 13, 14, 15, 16, 17, 20, 22, 25, 28, 33, 40, 42, 45, 59,
      62, 65,
    ]);
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await route(relay(), new Request("http://localhost/", { method: "OPTIONS" }));
    expect(res!.status).toBe(204);
    expect(res!.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("GET without the Accept header falls through (to a 426 here)", async () => {
    const res = await route(relay(), new Request("http://localhost/"));
    expect(res!.status).toBe(426);
  });

  test("non-GET, non-OPTIONS without Accept falls through", async () => {
    const res = await route(
      relay(),
      new Request("http://localhost/", { method: "POST" }),
    );
    expect(res!.status).toBe(426);
  });
});
