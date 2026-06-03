/**
 * Relay construction helpers: wire up the standard plugin set and build a
 * relay from environment variables.
 */
import { Relay, type RelayServer } from "./relay.ts";
import { nip01 } from "./plugins/nip01.ts";
import { nip05, type Nip05Options } from "./plugins/nip05.ts";
import { nip09 } from "./plugins/nip09.ts";
import { nip11 } from "./plugins/nip11.ts";
import { nip13 } from "./plugins/nip13.ts";
import { nip22 } from "./plugins/nip22.ts";
import { nip40 } from "./plugins/nip40.ts";
import { nip45 } from "./plugins/nip45.ts";
import { conventions } from "./plugins/conventions.ts";
import { MemoryEventStore } from "./store/memory-store.ts";
import { SqliteEventStore } from "./store/sqlite-store.ts";
import type { RelayConfig } from "./plugin.ts";

/** Optional, opt-in plugin configuration for {@link createRelay}. */
export interface RelayPlugins {
  /** NIP-05 name->pubkey directory. Omit to not serve /.well-known/nostr.json. */
  nip05?: Nip05Options;
  /** NIP-40 expired-event sweep interval (ms). 0/undefined disables the sweep. */
  expirationSweepMs?: number;
}

/**
 * Build a relay with the full standard plugin set:
 *  - NIP-11 (info doc) and NIP-01 (core protocol)
 *  - NIP-09 + NIP-62 (deletion / request to vanish)
 *  - NIP-40 (expiration), NIP-45 (COUNT)
 *  - NIP-13 (PoW) and NIP-22 (created_at limits) — only active when the matching
 *    `config.limitation` fields are set; otherwise they accept everything
 *  - the convention NIPs (advertised; handled generically by NIP-01)
 *  - NIP-05 only when `plugins.nip05` is provided
 */
export function createRelay(config: RelayConfig = {}, plugins: RelayPlugins = {}): Relay {
  const relay = new Relay(config);
  relay.use(nip11(() => relay.info));
  relay.use(nip01(relay));
  relay.use(nip09());
  relay.use(nip40({ sweepIntervalMs: plugins.expirationSweepMs }));
  relay.use(nip45());
  relay.use(nip13({ minPow: config.limitation?.min_pow_difficulty }));
  relay.use(
    nip22({
      lower: config.limitation?.created_at_lower_limit,
      upper: config.limitation?.created_at_upper_limit,
    }),
  );
  relay.use(conventions());
  if (plugins.nip05) relay.use(nip05(plugins.nip05));
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

  // NIP-05: RELAY_NIP05 holds a JSON name->pubkey map (e.g. {"alice":"<hex>"}).
  let nip05Names: Record<string, string> | undefined;
  if (env.RELAY_NIP05) {
    nip05Names = JSON.parse(env.RELAY_NIP05) as Record<string, string>;
  }

  const relay = createRelay(
    {
      name: env.RELAY_NAME ?? "beamhop",
      description: "A lightweight, zero-dependency NOSTR relay on Bun.",
      software: "https://github.com/beamhop/relay",
      version: "0.1.0",
      url: env.RELAY_URL,
      store,
      limitation: {
        max_limit: 500,
        max_subscriptions: 20,
        max_message_length: 262144,
        // Optional restrictions, off unless the env var is set.
        min_pow_difficulty: numOrUndef(env.RELAY_MIN_POW),
        created_at_lower_limit: numOrUndef(env.RELAY_CREATED_AT_LOWER),
        created_at_upper_limit: numOrUndef(env.RELAY_CREATED_AT_UPPER),
      },
    },
    {
      nip05: nip05Names ? { names: nip05Names } : undefined,
      expirationSweepMs: numOrUndef(env.RELAY_EXPIRATION_SWEEP_MS),
    },
  );

  const port = env.PORT !== undefined ? Number(env.PORT) : 7000;

  return relay.listen(port, { hostname: env.HOST, tls: tlsFromEnv(env) });
}

/**
 * Build native-TLS options from the environment. Set TLS_CERT and TLS_KEY to
 * file paths to serve `wss://` directly (no reverse proxy). Returns undefined
 * when either is missing, in which case the relay serves plaintext `ws://`.
 */
export function tlsFromEnv(env: NodeJS.ProcessEnv): Bun.TLSOptions | undefined {
  if (!env.TLS_CERT || !env.TLS_KEY) return undefined;
  return { cert: Bun.file(env.TLS_CERT), key: Bun.file(env.TLS_KEY) };
}

/** Parse an env var as a number, or undefined if unset/blank. */
function numOrUndef(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
