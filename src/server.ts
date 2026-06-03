/**
 * Relay construction helpers: wire up the standard plugin set and build a
 * relay from environment variables.
 */
import { Relay, type RelayServer } from "./relay.ts";
import { nip01 } from "./plugins/nip01.ts";
import { nip11 } from "./plugins/nip11.ts";
import { MemoryEventStore } from "./store/memory-store.ts";
import { SqliteEventStore } from "./store/sqlite-store.ts";
import type { RelayConfig } from "./plugin.ts";

/** Build a relay with NIP-01 + NIP-11 wired up. */
export function createRelay(config: RelayConfig = {}): Relay {
  const relay = new Relay(config);
  relay.use(nip11(() => relay.info));
  relay.use(nip01(relay));
  return relay;
}

/**
 * Build a relay from environment variables and start listening.
 * RELAY_DB enables SQLite persistence; PORT sets the listen port (0 = ephemeral).
 */
export function startFromEnv(env: NodeJS.ProcessEnv = process.env): RelayServer {
  const store = env.RELAY_DB
    ? new SqliteEventStore(env.RELAY_DB)
    : new MemoryEventStore();

  const relay = createRelay({
    name: env.RELAY_NAME ?? "nostr-relay-ts",
    description: "A lightweight, zero-dependency NOSTR relay on Bun.",
    software: "https://github.com/nostr-relay-ts",
    version: "0.1.0",
    store,
    limitation: {
      max_limit: 500,
      max_subscriptions: 20,
      max_message_length: 262144,
    },
  });

  const port = env.PORT !== undefined ? Number(env.PORT) : 7000;
  return relay.listen(port);
}
