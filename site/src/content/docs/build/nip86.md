---
title: NIP-86 management API
description: Manage a beamhop relay from any NIP-86 client — supported methods, the permission each needs, auth with NIP-98, and request examples.
sidebar:
  order: 14
---

[NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md) is a small, standard JSON-RPC-like API for relay
management. Tools that speak it work with beamhop out of the box. It covers the everyday moderation calls; for
everything else, use the [admin REST API](/relay/build/admin-api/).

NIP-86 is served while the admin API is enabled, and `86` is then listed in the NIP-11 `supported_nips`.

## Request format

```http
POST / HTTP/1.1
Host: relay.example.com
Content-Type: application/nostr+json+rpc
Authorization: Nostr <base64 of a signed kind 27235 event>

{"method": "banpubkey", "params": ["<hex pubkey>", "spam"]}
```

- The request goes to the relay's root URL with the `application/nostr+json+rpc` content type.
- The answer is `{ "result": … }` on success or `{ "result": null, "error": "…" }`, with the same content type.
- CORS is open (`Access-Control-Allow-Origin: *`), since management clients are often web apps on other origins.
  Auth is the header, never a cookie.
- The body may be at most 64 KiB.

## Authorization

Every call needs a NIP-98 event (kind 27235) in the `Authorization` header:

- `u`: the relay URL. Its `http(s)://` or `ws(s)://` form is accepted, with or without a trailing slash, plus the
  query string if the request has one.
- `method`: `POST`.
- `payload`: the hex SHA-256 of the request body. **Required** for NIP-86.
- `created_at` within 60 seconds of the server's clock. Each event is accepted once.

The signer must be a relay admin. The role decides which methods may be called, using the same permissions as the
admin API (see [Roles and permissions](/relay/build/admin-api/#roles-and-permissions)).

| Status | Meaning |
| --- | --- |
| `401` | Missing, invalid, expired or reused authorization. |
| `403` | Not an admin, or the role lacks the method's permission. |
| `413` | Body over 64 KiB. |
| `200` with `error` | The call reached the method and failed (bad params, a rank rule, …). |

## Methods

`supportedmethods` returns only the methods your role may call.

| Method | Params | Permission | Returns |
| --- | --- | --- | --- |
| `supportedmethods` | — | any admin | `string[]` |
| `banpubkey` | `pubkey`, `reason?` | `users.ban` | `true` |
| `unbanpubkey` | `pubkey`, `reason?` | `users.ban` | `true` |
| `listbannedpubkeys` | — | `users.view` | `{ pubkey, reason }[]` |
| `allowpubkey` | `pubkey`, `reason?` | `users.edit` | `true` |
| `unallowpubkey` | `pubkey`, `reason?` | `users.edit` | `true` |
| `listallowedpubkeys` | — | `users.view` | `{ pubkey, reason }[]` |
| `listeventsneedingmoderation` | — | `reports.view` | `{ id, reason }[]` — events with open reports |
| `allowevent` | `id`, `reason?` | `reports.resolve` | `true` |
| `banevent` | `id`, `reason?` | `content.delete` | `true` |
| `unbanevent` | `id`, `reason?` | `content.delete` | `true` |
| `listbannedevents` | — | `content.view` | `{ id, reason }[]` |
| `changerelayname` | `name` | `settings.edit` | `true` |
| `changerelaydescription` | `description` | `settings.edit` | `true` |
| `changerelayicon` | `icon` (URL) | `settings.edit` | `true` |
| `allowkind` | `kind` | `settings.edit` | `true` |
| `disallowkind` | `kind` | `settings.edit` | `true` |
| `listallowedkinds` | — | `settings.view` | `number[]` |
| `listdisallowedkinds` | — | `settings.view` | `number[]` |
| `blockip` | `ip` (address or CIDR), `reason?` | `ip.manage` | `true` |
| `unblockip` | `ip` | `ip.manage` | `true` |
| `listblockedips` | — | `ip.manage` | `{ ip, reason }[]` |

Pubkeys may be hex or npub. Event ids are 64-character hex.

### How methods map to beamhop

- **`banpubkey`** bans the user, like a ban in the panel. Every ban also removes the user from the allow list.
- **`allowpubkey`** adds the user to the allow list used by the whitelist access mode.
- **`banevent`** deletes the event and records a ban, so it can't be published again — through any instance sharing
  the database. Banning an event that isn't stored here needs the owner role.
- **`unbanevent`** lifts the write block only; the deleted event isn't restored. A ban can only be lifted by a role at
  least as high as the one that placed it.
- **`allowevent`** dismisses the open reports against the event and lifts any ban on it.
- **`allowkind`** removes the kind from the block list. If the relay has a kind allow list, the kind is added to it.
  With no allow list (all kinds accepted), the kind is only noted so `listallowedkinds` shows it.
- **`disallowkind`** adds the kind to the block list, which always wins over the allow list.
- **`blockip`** adds a block rule and disconnects matching connections.

The same rank rules as the panel apply: below owner, you can't ban or delete the content of a peer or superior. Every
call is recorded in the audit log, tagged `via: "nip86"`.

## Example

With [nostr-tools](https://github.com/nbd-wtf/nostr-tools):

```ts
import { finalizeEvent } from "nostr-tools/pure";
import { createHash } from "node:crypto";

const relay = "https://relay.example.com";
const body = JSON.stringify({ method: "listbannedpubkeys", params: [] });

const auth = finalizeEvent({
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["u", relay],
    ["method", "POST"],
    ["payload", createHash("sha256").update(body).digest("hex")],
  ],
  content: "",
}, secretKey);

const res = await fetch(relay, {
  method: "POST",
  headers: {
    "Content-Type": "application/nostr+json+rpc",
    Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
  },
  body,
});
const { result, error } = await res.json();
```

The `u` tag must match the relay's public URL (`server.publicUrl`), not whatever address you happen to reach it on.
