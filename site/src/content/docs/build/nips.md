---
title: NIP support
description: Which Nostr NIPs beamhop implements, which it advertises in NIP-11 and when, and which client-side NIPs work through plain storage.
sidebar:
  order: 2
---

beamhop implements the relay side of the NIPs below. Clients can read the list from the NIP-11 document's
`supported_nips` field:

```sh
curl -H 'Accept: application/nostr+json' https://relay.example.com/
```

## Implemented and advertised

| NIP | What beamhop does |
| --- | --- |
| [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | Basic protocol: `EVENT`, `REQ`, `CLOSE`, replaceable, ephemeral and addressable kinds. |
| [04](https://github.com/nostr-protocol/nips/blob/master/04.md) | Encrypted DMs (kind 4) are only delivered to a connection authenticated (NIP-42) as the sender or a `p`-tagged recipient. |
| [05](https://github.com/nostr-protocol/nips/blob/master/05.md) | Serves `/.well-known/nostr.json` for local names (`name@relay-domain`). |
| [09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Deletion requests (kind 5) remove the author's events and leave tombstones. |
| [11](https://github.com/nostr-protocol/nips/blob/master/11.md) | Relay information document, built from the runtime settings. |
| [13](https://github.com/nostr-protocol/nips/blob/master/13.md) | Optional minimum proof-of-work difficulty for writes. |
| [17](https://github.com/nostr-protocol/nips/blob/master/17.md) | Private DMs: gift-wrapped messages are only delivered to their recipient. |
| [29](https://github.com/nostr-protocol/nips/blob/master/29.md) | Relay-based groups: membership, roles, open/closed and private/hidden groups, invite codes. |
| [40](https://github.com/nostr-protocol/nips/blob/master/40.md) | Expiration: already-expired events are refused, and stored ones are purged once they expire. |
| [42](https://github.com/nostr-protocol/nips/blob/master/42.md) | Client authentication, used by the access modes and gated kinds. |
| [45](https://github.com/nostr-protocol/nips/blob/master/45.md) | `COUNT`, with the same visibility rules as `REQ`. Counts are exact, never `approximate`. |
| [50](https://github.com/nostr-protocol/nips/blob/master/50.md) | Full-text search via the `search` filter field. |
| [56](https://github.com/nostr-protocol/nips/blob/master/56.md) | Reports (kind 1984) feed the admin Reports queue and optional auto-bans. |
| [59](https://github.com/nostr-protocol/nips/blob/master/59.md) | Gift wraps (kind 1059) are only delivered to a connection authenticated as the `p`-tagged recipient. |
| [62](https://github.com/nostr-protocol/nips/blob/master/62.md) | Requests to vanish delete everything from a pubkey, and keep it deleted. |
| [70](https://github.com/nostr-protocol/nips/blob/master/70.md) | Protected events are only accepted from their authenticated author. |
| [77](https://github.com/nostr-protocol/nips/blob/master/77.md) | Negentropy set reconciliation (`NEG-OPEN`, `NEG-MSG`, `NEG-CLOSE`) for efficient sync. |
| [86](https://github.com/nostr-protocol/nips/blob/master/86.md) | Relay management RPC over HTTP with NIP-98 auth. See [NIP-86](/relay/build/nip86/). |

### Conditionally advertised

Three NIPs belong to features you can turn off. They are only listed in `supported_nips` while the feature is on:

| NIP | Advertised while |
| --- | --- |
| 05 | NIP-05 is enabled in the runtime settings (`nip05.enabled`). |
| 29 | Groups are enabled in the runtime settings (`groups.enabled`). |
| 86 | The admin API is enabled (`admin.enabled` in the config, on by default). |

The admin panel's system page (`GET /admin/api/system`) reports the same list in its `nips` field.

## Client-side NIPs that just work

Many NIPs only describe how clients shape events. A relay doesn't need to know about them: storing and serving
events by NIP-01 filters is enough. These work on beamhop through generic storage:

| NIP | What it is |
| --- | --- |
| [02](https://github.com/nostr-protocol/nips/blob/master/02.md) | Follow lists (kind 3) |
| [10](https://github.com/nostr-protocol/nips/blob/master/10.md) | Reply threading with `e` and `p` tags |
| [22](https://github.com/nostr-protocol/nips/blob/master/22.md) | Comments (kind 1111) |
| [28](https://github.com/nostr-protocol/nips/blob/master/28.md) | Public chat channels |
| [44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Versioned encryption (used inside other kinds) |
| [51](https://github.com/nostr-protocol/nips/blob/master/51.md) | Lists (mute lists, bookmarks, sets) |
| [65](https://github.com/nostr-protocol/nips/blob/master/65.md) | Relay list metadata (kind 10002) |

Following NIP-11, beamhop doesn't advertise these: `supported_nips` is meant for NIPs the relay itself implements.
Other client-side NIPs work the same way; this list is just the common ones.

## Limits clients will run into

The NIP-11 `limitation` object tells clients the current limits: message size, subscriptions, filters, `limit`,
tag count, content length, minimum PoW, and whether auth is required or writes are restricted. All of them come
from the runtime settings an admin edits in the panel.

A few behaviours worth knowing when you write a client:

- `OK` and `CLOSED` messages carry the NIP-01 machine-readable prefixes (`blocked:`, `rate-limited:`,
  `restricted:`, `duplicate:`, `error:` and so on).
- A read refused by a hard cap a retry can't fix is `CLOSED` with `restricted:`; a transient one with `rate-limited:`.
- An event that is already stored is answered `duplicate:` before any rate limit is charged.
- The `limit` of a NIP-50 search filter is clamped to 100.
- A connection may have at most 100 `EVENT`s waiting for their `OK`.
- During shutdown, every queued `EVENT` still gets an `OK`; new messages get `error: relay is shutting down`.
