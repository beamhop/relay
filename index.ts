/**
 * Public entry point.
 *
 * Storage is in-memory by default. Set RELAY_DB to a file path to enable
 * SQLite persistence (bun:sqlite). Set PORT to change the listen port.
 *
 * This file is the thin runnable shim; the relay-building logic lives in
 * src/server.ts so it can be unit-tested directly.
 */
import { startFromEnv } from "./src/server.ts";

export { Relay } from "./src/relay.ts";
export { nip01 } from "./src/plugins/nip01.ts";
export { nip11 } from "./src/plugins/nip11.ts";
export { MemoryEventStore } from "./src/store/memory-store.ts";
export { SqliteEventStore } from "./src/store/sqlite-store.ts";
export { createRelay, startFromEnv } from "./src/server.ts";
export type { NostrPlugin, PluginContext, RelayConfig } from "./src/plugin.ts";
export type {
  ClientMessage,
  Filter,
  NostrEvent,
  RelayMessage,
  UnsignedEvent,
} from "./src/types.ts";

if (import.meta.main) {
  const server = startFromEnv();
  const scheme = server.url.protocol === "https:" ? "wss" : "ws";
  console.log(`nostr-relay-ts listening on ${scheme}://${server.hostname}:${server.port}`);
}
