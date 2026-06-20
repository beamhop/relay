import { afterEach, expect, test } from "bun:test";
import { ManagementState } from "../src/management";
import { createPluginManager } from "../src/plugins";
import { startRelay } from "../src/server";
import { MemoryEventStore } from "../src/storage";
import type { RelayMessage } from "../src/types";
import { secretKey, signedEvent, testConfig, waitFor } from "./helpers";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("serves NIP-11 metadata and relays published events to subscriptions", async () => {
  const config = testConfig();
  const store = new MemoryEventStore();
  const plugins = createPluginManager(config);
  const server = await startRelay({ config, store, plugins, management: new ManagementState() });
  servers.push(server);

  const info = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { accept: "application/nostr+json" } }).then((response) => response.json());
  expect(info.supported_nips).toContain(1);
  expect(info.supported_nips).toContain(11);

  const messages: RelayMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as RelayMessage));
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined), "websocket open");
  await waitFor(() => messages.find((message) => message[0] === "AUTH"), "AUTH challenge");

  ws.send(JSON.stringify(["REQ", "sub", { kinds: [1] }]));
  await waitFor(() => messages.find((message) => message[0] === "EOSE" && message[1] === "sub"), "EOSE");

  const note = signedEvent(secretKey(9), { kind: 1, content: "hello relay" });
  ws.send(JSON.stringify(["EVENT", note]));
  await waitFor(() => messages.find((message) => message[0] === "OK" && message[1] === note.id && message[2] === true), "OK");
  const delivered = await waitFor(
    () => messages.find((message) => message[0] === "EVENT" && message[1] === "sub" && message[2].id === note.id),
    "subscription event",
  );
  expect(delivered[0]).toBe("EVENT");
  ws.close();
});

test("responds to NIP-77 NEG-OPEN with a protocol v1 NEG-MSG", async () => {
  const config = testConfig();
  const store = new MemoryEventStore();
  const note = signedEvent(secretKey(10), { kind: 1, content: "sync me" });
  await store.save(note);
  const server = await startRelay({ config, store, plugins: createPluginManager(config), management: new ManagementState() });
  servers.push(server);

  const messages: RelayMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as RelayMessage));
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined), "websocket open");

  ws.send(JSON.stringify(["NEG-OPEN", "neg", { kinds: [1] }, "61"]));
  const response = await waitFor(() => messages.find((message) => message[0] === "NEG-MSG" && message[1] === "neg"), "NEG-MSG");
  expect(response[2]).toStartWith("61");
  expect(response[2]).toContain(note.id);
  ws.close();
});

test("serves password-protected admin panel and updates runtime config", async () => {
  const config = testConfig({ admin: { web: true, password: "secret" } });
  const store = new MemoryEventStore();
  const server = await startRelay({ config, store, plugins: createPluginManager(config), management: new ManagementState() });
  servers.push(server);

  const page = await fetch(`http://127.0.0.1:${server.port}/admin`);
  expect(page.status).toBe(200);
  const pageHtml = await page.text();
  expect(pageHtml).toContain("Beamhop Relay Admin");
  expect(pageHtml).toContain("Live peers");
  const script = pageHtml.match(/<script>([\s\S]*)<\/script>/)?.[1];
  expect(script).toBeString();
  expect(() => new Function(script as string)).not.toThrow();

  const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/api/status`);
  expect(unauthorized.status).toBe(401);

  const badLogin = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "wrong" }),
    headers: { "content-type": "application/json" },
  });
  expect(badLogin.status).toBe(401);

  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: "secret" }),
    headers: { "content-type": "application/json" },
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toStartWith("relay_admin_session=");

  const status = await fetch(`http://127.0.0.1:${server.port}/admin/api/status`, {
    headers: { cookie: cookie as string },
  }).then((response) => response.json());
  expect(status.stats.activeConnections).toBe(0);
  expect(status.stats.liveConnectedPeers).toBe(0);
  expect(status.plugins.supportedNips).toContain(50);

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined), "admin peer websocket open");
  const liveStatus = await fetch(`http://127.0.0.1:${server.port}/admin/api/status`, {
    headers: { cookie: cookie as string },
  }).then((response) => response.json());
  expect(liveStatus.stats.activeConnections).toBe(1);
  expect(liveStatus.stats.liveConnectedPeers).toBe(1);
  expect(liveStatus.connections).toHaveLength(1);
  ws.close();

  const updated = await fetch(`http://127.0.0.1:${server.port}/admin/api/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: cookie as string },
    body: JSON.stringify({
      relay: { name: "Updated Relay", description: "Changed from admin" },
      disabledNips: ["50"],
      requireAuthForRead: true,
      requireAuthForWrite: false,
      acceptProtectedEvents: true,
    }),
  }).then((response) => response.json());
  expect(updated.config.relay.name).toBe("Updated Relay");
  expect(updated.config.requireAuthForRead).toBe(true);
  expect(updated.plugins.supportedNips).not.toContain(50);

  const info = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { accept: "application/nostr+json" } }).then((response) => response.json());
  expect(info.name).toBe("Updated Relay");
  expect(info.supported_nips).not.toContain(50);
});
