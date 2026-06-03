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
export { nip05 } from "./src/plugins/nip05.ts";
export { nip09 } from "./src/plugins/nip09.ts";
export { nip11 } from "./src/plugins/nip11.ts";
export { nip13 } from "./src/plugins/nip13.ts";
export { nip17 } from "./src/plugins/nip17.ts";
export { nip22 } from "./src/plugins/nip22.ts";
export { nip40 } from "./src/plugins/nip40.ts";
export { nip42 } from "./src/plugins/nip42.ts";
export { nip45 } from "./src/plugins/nip45.ts";
export { conventions } from "./src/plugins/conventions.ts";
export { MemoryEventStore } from "./src/store/memory-store.ts";
export { SqliteEventStore } from "./src/store/sqlite-store.ts";
export { createRelay, startFromEnv } from "./src/server.ts";
export type { RelayPlugins } from "./src/server.ts";
export type {
  NostrPlugin,
  PluginContext,
  RelayConfig,
  VisibilityFilter,
} from "./src/plugin.ts";
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
