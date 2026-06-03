import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRelay } from "../src/server.ts";
import type { RelayServer } from "../src/relay.ts";
import type { RelayMessage } from "../src/types.ts";
import { events } from "./fixtures.ts";

let server: RelayServer;
let url: string;
let httpUrl: string;

beforeAll(() => {
  const relay = createRelay({
    name: "integration-relay",
    version: "0.1.0",
    limitation: { max_limit: 500, max_subscriptions: 20 },
  });
  server = relay.listen(0); // ephemeral port
  url = `ws://localhost:${server.port}`;
  httpUrl = `http://localhost:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
});

/** Open a socket and resolve once it is connected. */
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

/** Collect messages until `predicate` is satisfied or it times out. */
function collectUntil(
  ws: WebSocket,
  predicate: (msg: RelayMessage, all: RelayMessage[]) => boolean,
  timeoutMs = 2000,
): Promise<RelayMessage[]> {
  return new Promise((resolve, reject) => {
    const all: RelayMessage[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout; received: ${JSON.stringify(all)}`));
    }, timeoutMs);
    function onMessage(ev: MessageEvent) {
      const msg = JSON.parse(ev.data as string) as RelayMessage;
      all.push(msg);
      if (predicate(msg, all)) {
        cleanup();
        resolve(all);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    }
    ws.addEventListener("message", onMessage);
  });
}

describe("integration over real WebSocket", () => {
  test("NIP-11 document is served over HTTP", async () => {
    const res = await fetch(httpUrl, {
      headers: { Accept: "application/nostr+json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("integration-relay");
    expect(body.supported_nips).toContain(1);
    expect(body.supported_nips).toContain(11);
    expect(body.supported_nips).toContain(9); // deletion plugin is wired in
    expect(body.supported_nips).toContain(45); // COUNT
  });

  test("HTTP request without Accept gets a 426 upgrade-required", async () => {
    const res = await fetch(httpUrl);
    expect(res.status).toBe(426);
  });

  test("publish + REQ delivers stored events then EOSE", async () => {
    const publisher = await connect();
    publisher.send(JSON.stringify(["EVENT", events.metadata]));
    await collectUntil(publisher, (m) => m[0] === "OK");

    const reader = await connect();
    reader.send(JSON.stringify(["REQ", "sub1", { kinds: [0] }]));
    const msgs = await collectUntil(reader, (m) => m[0] === "EOSE");

    const evMsg = msgs.find((m) => m[0] === "EVENT");
    expect(evMsg).toBeDefined();
    expect((evMsg as ["EVENT", string, typeof events.metadata])[2].id).toBe(
      events.metadata.id,
    );
    expect(msgs.at(-1)![0]).toBe("EOSE");

    publisher.close();
    reader.close();
  });

  test("COUNT returns the number of matching events (NIP-45)", async () => {
    const publisher = await connect();
    publisher.send(JSON.stringify(["EVENT", events.contacts])); // kind 3
    await collectUntil(publisher, (m) => m[0] === "OK");

    const counter = await connect();
    counter.send(JSON.stringify(["COUNT", "c1", { kinds: [3] }]));
    const msgs = await collectUntil(counter, (m) => m[0] === "COUNT");
    const countMsg = msgs.find((m) => m[0] === "COUNT") as
      | ["COUNT", string, { count: number }]
      | undefined;
    expect(countMsg).toBeDefined();
    expect(countMsg![1]).toBe("c1");
    expect(countMsg![2].count).toBeGreaterThanOrEqual(1);

    publisher.close();
    counter.close();
  });

  test("live event is pushed to an open matching subscription", async () => {
    const reader = await connect();
    reader.send(JSON.stringify(["REQ", "live", { kinds: [1] }]));
    await collectUntil(reader, (m) => m[0] === "EOSE");

    const livePromise = collectUntil(
      reader,
      (m) => m[0] === "EVENT" && m[2].id === events.note.id,
    );

    const publisher = await connect();
    publisher.send(JSON.stringify(["EVENT", events.note]));

    const msgs = await livePromise;
    expect(msgs.some((m) => m[0] === "EVENT" && m[2].id === events.note.id)).toBe(true);

    publisher.close();
    reader.close();
  });
});
