# nostr-relay-ts

A lightweight, **zero-dependency** [NOSTR](https://github.com/nostr-protocol/nips) relay built on [Bun](https://bun.sh), with a **plugin architecture** so each NIP can be plugged in, out, or extended independently. It is compatible with the [iris.to](https://iris.to) client.

- **Zero runtime dependencies.** Only Bun internals are used: `Bun.serve` (HTTP + WebSocket), `node:crypto` (SHA-256), and optionally `bun:sqlite` (persistence). BIP-340 Schnorr signature verification over secp256k1 is implemented from scratch in pure TypeScript (`BigInt`), because Bun ships no native secp256k1.
- **Plugin-based.** [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) (core protocol) and [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) (relay information document) are themselves plugins. Adding a NIP is a single `relay.use(...)` call.
- **Tested.** 100% line and function coverage of all product code, run with the Bun test runner.

## Supported NIPs

Each NIP below is wired in by `createRelay` (`src/server.ts`). NIPs that impose
active relay behavior live in their own plugin (`src/plugins/nipNN.ts`); the
client-side convention NIPs are handled generically by NIP-01 and advertised via
a single `conventions` plugin.

| NIP | What the relay does |
| --- | ------------------- |
| [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | `EVENT`/`REQ`/`CLOSE`, `EVENT`/`OK`/`EOSE`/`CLOSED`/`NOTICE`, event id + Schnorr verification, filters, replaceable/ephemeral/addressable storage. |
| [02](https://github.com/nostr-protocol/nips/blob/master/02.md) | Follow lists (kind 3) stored as replaceable events. |
| [03](https://github.com/nostr-protocol/nips/blob/master/03.md) | OpenTimestamps attestations (kind 1040) stored as regular events. |
| [04](https://github.com/nostr-protocol/nips/blob/master/04.md) | Encrypted DMs (kind 4); content is client-encrypted, queryable by `#p`. |
| [05](https://github.com/nostr-protocol/nips/blob/master/05.md) | Serves `/.well-known/nostr.json?name=…` from a configurable name→pubkey map (with CORS). Opt-in. |
| [09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event deletion (kind 5): deletes the author's own events referenced by `e`/`a` tags. |
| [11](https://github.com/nostr-protocol/nips/blob/master/11.md) | Relay info document over HTTP (`Accept: application/nostr+json`) with CORS. |
| [12](https://github.com/nostr-protocol/nips/blob/master/12.md) | Generic single-letter tag queries (`#e`, `#p`, `#t`, …). |
| [13](https://github.com/nostr-protocol/nips/blob/master/13.md) | Proof-of-Work: rejects events below a configurable minimum difficulty (off by default). |
| [14](https://github.com/nostr-protocol/nips/blob/master/14.md) | `subject` tag on text notes — stored and served. |
| [15](https://github.com/nostr-protocol/nips/blob/master/15.md) | End-of-stored-events `EOSE` after a `REQ`'s stored batch. |
| [16](https://github.com/nostr-protocol/nips/blob/master/16.md) | Replaceable (10000–19999) and ephemeral (20000–29999) event treatment. |
| [20](https://github.com/nostr-protocol/nips/blob/master/20.md) | Command results via `OK` messages. |
| [22](https://github.com/nostr-protocol/nips/blob/master/22.md) | `created_at` lower/upper bounds (off by default). |
| [25](https://github.com/nostr-protocol/nips/blob/master/25.md) | Reactions (kind 7). |
| [28](https://github.com/nostr-protocol/nips/blob/master/28.md) | Public chat (kinds 40–44). |
| [33](https://github.com/nostr-protocol/nips/blob/master/33.md) | Parameterized replaceable / addressable events (30000–39999), keyed by `d` tag. |
| [40](https://github.com/nostr-protocol/nips/blob/master/40.md) | Expiration: rejects already-expired events, hides expired events from `REQ`/broadcast, optional background sweep. |
| [44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Versioned encrypted payloads (client-side content scheme). |
| [45](https://github.com/nostr-protocol/nips/blob/master/45.md) | `COUNT` — returns the number of stored events matching the filters. |
| [62](https://github.com/nostr-protocol/nips/blob/master/62.md) | Request to vanish (kind 62): erases the author's history (scoped by `relay` tags). |
| [65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata (kind 10002) stored as a replaceable event. |

## Quick start

```sh
bun install            # installs only @types/bun (dev type package; no runtime deps)
bun run index.ts       # listens on ws://localhost:7000
```

Configuration via environment variables:

| Var | Default | Effect |
| --- | ------- | ------ |
| `PORT` | `7000` | Listen port (`0` = ephemeral). |
| `HOST` | `0.0.0.0` | Bind hostname. |
| `RELAY_DB` | _(unset)_ | If set, use SQLite persistence at this path. Otherwise in-memory. |
| `RELAY_NAME` | `beamhop` | Name shown in the NIP-11 document. |
| `RELAY_URL` | _(unset)_ | This relay's public `wss://` URL; lets NIP-62 vanish requests target it. |
| `RELAY_NIP05` | _(unset)_ | JSON name→pubkey map enabling the NIP-05 `/.well-known/nostr.json` endpoint, e.g. `{"alice":"<hex>"}`. |
| `RELAY_MIN_POW` | _(unset)_ | NIP-13 minimum PoW difficulty (leading zero bits). Unset = no PoW requirement. |
| `RELAY_CREATED_AT_LOWER` | _(unset)_ | NIP-22: max seconds an event may be older than the relay clock. |
| `RELAY_CREATED_AT_UPPER` | _(unset)_ | NIP-22: max seconds an event may be in the future. |
| `RELAY_EXPIRATION_SWEEP_MS` | _(unset)_ | NIP-40 background sweep interval (ms). Unset/`0` = no sweep (expired events are still hidden from clients). |
| `TLS_CERT` / `TLS_KEY` | _(unset)_ | File paths to serve `wss://` natively (no reverse proxy). |

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

## Deploying `wss://` (single process, no reverse proxy)

Bun terminates TLS in-process, so the relay serves `wss://` directly from a
certificate — no Caddy/nginx needed. Point `TLS_CERT`/`TLS_KEY` at a
Let's Encrypt cert and you're done.

```sh
# 1. Issue the cert (run on the dev.beamhop.com host; needs port 80 reachable).
sudo DOMAIN=dev.beamhop.com EMAIL=you@example.com ./deploy/setup-tls.sh

# 2. Run the relay as a single process serving wss:// on :7000.
PORT=7000 \
RELAY_URL=wss://dev.beamhop.com \
TLS_CERT=/etc/letsencrypt/live/dev.beamhop.com/fullchain.pem \
TLS_KEY=/etc/letsencrypt/live/dev.beamhop.com/privkey.pem \
bun run index.ts
```

For an always-on service, `deploy/nostr-relay.service` is a ready systemd unit
(set `User`/paths, then `systemctl enable --now nostr-relay`). Bun does not
hot-reload certs, so add a certbot deploy hook to restart the relay after each
renewal — `deploy/setup-tls.sh` prints the exact commands.

For local testing without a real CA, a self-signed cert works too (clients will
warn about trust):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=dev.beamhop.com"
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=7000 bun run index.ts
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

export function myPlugin(): NostrPlugin {
  return {
    name: "my-plugin",
    supportedNips: [9999],
    messageHandlers: {
      // EVENT/REQ/CLOSE/COUNT are taken by other plugins; add new verbs or
      // additional validators here.
    },
    eventValidators: [
      (event) => (event.kind === 1234 ? validateSpecialKind(event) : { ok: true }),
    ],
  };
}

// then:  relay.use(myPlugin())
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
    nip01.ts          core protocol (EVENT/REQ/CLOSE, validation, EOSE/OK)
    nip05.ts          /.well-known/nostr.json identity endpoint (opt-in)
    nip09.ts          event deletion (kind 5) + request to vanish (kind 62)
    nip11.ts          relay info document
    nip13.ts          proof-of-work minimum difficulty (config-gated)
    nip22.ts          created_at lower/upper bounds (config-gated)
    nip40.ts          expiration: reject/hide/sweep expired events
    nip45.ts          COUNT
    conventions.ts    advertises NIPs handled generically by NIP-01
```

Time-sensitive plugins (NIP-40, NIP-22) read the clock from `config.now`
(Unix seconds), which defaults to the wall clock and is injectable for
deterministic tests. NIP-40 also adds a *visibility filter* — a plugin hook on
the relay that gates which stored events are served (`REQ`) and broadcast,
without mutating or deleting them.

## Tests

```sh
bun test               # run the suite (coverage gated at 99% via bunfig.toml)
bun run coverage       # text coverage report
bun run typecheck      # tsc --noEmit (strict)
```

Coverage highlights: BIP-340 verification is checked against the official test vectors (valid signatures plus the off-curve, out-of-range, wrong-parity, and infinite-`R` failure cases); event-id computation is verified against pre-signed fixtures including unicode/control-char content; both stores run an identical behavioral suite; and an integration test drives a real `Bun.serve` instance over real WebSocket clients.
