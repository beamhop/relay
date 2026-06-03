# nostr-relay-ts

A lightweight, **zero-dependency** [NOSTR](https://github.com/nostr-protocol/nips) relay built on [Bun](https://bun.sh), with a **plugin architecture** so each NIP can be plugged in, out, or extended independently. It is compatible with the [iris.to](https://iris.to) client.

- **Zero runtime dependencies.** Only Bun internals are used: `Bun.serve` (HTTP + WebSocket), `node:crypto` (SHA-256), and optionally `bun:sqlite` (persistence). BIP-340 Schnorr signature verification over secp256k1 is implemented from scratch in pure TypeScript (`BigInt`), because Bun ships no native secp256k1.
- **Plugin-based.** [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) (core protocol) and [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) (relay information document) are themselves plugins. Adding a NIP is a single `relay.use(...)` call.
- **Tested.** 100% line and function coverage of all product code, run with the Bun test runner.

## Supported NIPs

| NIP | What | Why iris needs it |
| --- | ---- | ----------------- |
| [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) | `EVENT`/`REQ`/`CLOSE`, `EVENT`/`OK`/`EOSE`/`CLOSED`/`NOTICE`, event id + Schnorr verification, filters, replaceable/ephemeral/addressable storage | The core protocol. iris subscribes with `REQ` for kinds `[0,1,3,6,7]`. |
| [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) | Relay info document over HTTP (`Accept: application/nostr+json`) with CORS | Lets browser clients introspect the relay. |

## Quick start

```sh
bun install            # installs only @types/bun (dev type package; no runtime deps)
bun run index.ts       # listens on ws://localhost:7000
```

Configuration via environment variables:

| Var | Default | Effect |
| --- | ------- | ------ |
| `PORT` | `7000` | Listen port (`0` = ephemeral). |
| `RELAY_DB` | _(unset)_ | If set, use SQLite persistence at this path. Otherwise in-memory. |
| `RELAY_NAME` | `nostr-relay-ts` | Name shown in the NIP-11 document. |

```sh
# In-memory (default): events are lost on restart
bun start

# Persistent: events survive restarts
RELAY_DB=relay.db bun start
```

Fetch the relay info document:

```sh
curl -H "Accept: application/nostr+json" http://localhost:7000/
```

## Storage

Storage is **in-memory by default**, with **opt-in SQLite persistence**, both behind the same `EventStore` interface (`src/store/store.ts`). Choose explicitly in code:

```ts
import { createRelay, MemoryEventStore, SqliteEventStore } from "./index.ts";

const relay = createRelay({
  name: "my-relay",
  store: new SqliteEventStore("relay.db"), // or omit for MemoryEventStore
  limitation: { max_limit: 500, max_subscriptions: 20 },
});
relay.listen(7000);
```

`index.ts` also reads `RELAY_DB` as a convenience wrapper around the same option.

## Writing a plugin

A plugin contributes any of: message-verb handlers, event validators, HTTP routes, NIP-11 metadata, and lifecycle hooks (`src/plugin.ts`). The relay composes plugins in registration order.

```ts
import type { NostrPlugin } from "./src/plugin.ts";

export function nip09(): NostrPlugin {
  return {
    name: "nip09",
    supportedNips: [9],
    messageHandlers: {
      // EVENT/REQ/CLOSE are taken by nip01; add new verbs or new validators here
    },
    eventValidators: [
      (event) => (event.kind === 5 ? handleDeletion(event) : { ok: true }),
    ],
  };
}

// then:  relay.use(nip09())
```

- A `messageHandler` returning `true` claims the message (dispatch stops).
- All plugins' `eventValidators` run before an event is accepted; the first `{ ok: false }` rejects it with an `OK false` reply.
- `httpRoutes` are tried before the WebSocket upgrade; return a `Response` to claim the request or `undefined` to pass it on.

## Architecture

```
index.ts              thin runnable shim (re-exports + import.meta.main guard)
src/
  server.ts           createRelay() / startFromEnv() factories
  relay.ts            Relay: plugin registry, dispatch, validation, broadcast, Bun.serve wiring
  connection.ts       per-connection subscription state + send()
  plugin.ts           NostrPlugin contract, PluginContext, RelayConfig
  types.ts            NostrEvent, Filter, client/relay message types
  event.ts            serialize, getEventHash, validateStructure, verifyEvent
  filter.ts           matchFilter / matchFilters
  crypto/
    hex.ts            hex <-> bytes, UTF-8, BigInt conversions
    sha256.ts         SHA-256 via node:crypto
    secp256k1.ts      pure-BigInt field/curve math (Jacobian scalar mul), lift_x
    schnorr.ts        BIP-340 tagged hash + verify
  store/
    store.ts          EventStore interface + storage-class helpers
    memory-store.ts   in-memory backend (default)
    sqlite-store.ts   bun:sqlite backend (opt-in)
  plugins/
    nip01.ts          core protocol
    nip11.ts          relay info document
```

## Tests

```sh
bun test               # run the suite (coverage gated at 99% via bunfig.toml)
bun run coverage       # text coverage report
bun run typecheck      # tsc --noEmit (strict)
```

Coverage highlights: BIP-340 verification is checked against the official test vectors (valid signatures plus the off-curve, out-of-range, wrong-parity, and infinite-`R` failure cases); event-id computation is verified against pre-signed fixtures including unicode/control-char content; both stores run an identical behavioral suite; and an integration test drives a real `Bun.serve` instance over real WebSocket clients.
