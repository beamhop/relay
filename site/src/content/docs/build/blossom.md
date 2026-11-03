---
title: Blossom endpoints
description: The Blossom media routes beamhop serves, which BUDs they implement, and how auth, visibility and errors work.
sidebar:
  order: 3
---

beamhop has a [Blossom](https://github.com/hzrd149/blossom) server built in. Blobs are addressed by their SHA-256
hash and served from the relay's own origin, so any Blossom client can point at your relay URL and start uploading.

Implemented: **BUD-01, 02, 04, 06, 08, 11 and 12**. BUD-05 (media optimisation) and BUD-09 (reports) are not.

## Routes

| Route | BUD | What it does |
| --- | --- | --- |
| `GET` / `HEAD /<sha256>[.ext]` | 01 | Returns the blob. Any extension (case-insensitive) returns the same bytes. Range requests, `ETag`, `If-None-Match`, `If-Range`. |
| `GET` / `HEAD /thumb/<sha256>.webp` | — | A 320px WebP thumbnail, when thumbnails are on and `sharp` is installed. Same visibility as the blob. |
| `PUT /upload` | 02, 11 | Upload a blob. `201` when newly stored, `200` when it already existed. Returns a blob descriptor. |
| `HEAD /upload` | 06 | Upload preflight: asks "would this upload be accepted?" without sending the body. |
| `GET /list/<pubkey>` | 02, 12 | Lists a pubkey's blobs. Query: `since`, `until`, `limit`, `cursor`. Malformed values are a `400`. |
| `DELETE /<sha256>` | 02, 11 | Removes your ownership. The bytes are deleted once no owner is left. |
| `PUT /mirror` | 04 | Body `{"url": "…"}`: the server downloads the blob from another server and stores it. |
| `/media`, `/report` | 05, 09 | Not implemented. Every method gets a `404` with CORS headers, so browser clients see "not supported" rather than a network error. |

Every route sends CORS headers itself, and `OPTIONS` preflights pass.

## Authorization (BUD-11)

Write routes need an `Authorization: Nostr <base64 event>` header carrying a signed kind **24242** event:

- a `t` tag with the verb: `upload` (also used for `/mirror`), `delete`, `list` or `get`;
- an `expiration` tag. No token may be valid more than 24 hours past now or past its own `created_at`;
- for `upload` and `delete`, an `x` tag with the blob's hash. On upload it must match the bytes actually sent
  (and `X-SHA-256` when that header is sent). A `server` tag alone isn't enough;
- optionally `server` tags. If present, one of them must name this relay's host.

Some details that matter when you write a client:

- **Upload tokens** can be reused until they expire. But once the signer deletes a blob, their upload tokens for it
  signed before the delete stop working, so a captured token can't put it back.
- **Delete tokens** work once per blob they name. Replaying one against a re-uploaded blob gets `401`; retrying a
  delete for a blob that's already gone gets `404`.
- A malformed or expired token on a read is treated like no token at all.

## Visibility and moderation

Blobs have a moderation status: `approved`, `pending` or `blocked`.

- `approved` blobs are public.
- `pending` blobs are only served to their owners and relay staff (send a `t=get` token).
- `blocked` blobs are only served to staff.
- Anyone else gets a `404`, as if the blob didn't exist.

`GET /list/<pubkey>` only includes unapproved blobs when the caller authenticates (`t=list`) as that pubkey or as
staff. Staff means config owners and users with any admin-panel role who aren't banned.

## Serving safety

Blobs share the relay's origin with the admin panel, so they are never servable as code:

- JavaScript is served as `text/plain`, WebAssembly as `application/octet-stream` (the stored type is unchanged).
- Requests whose `Sec-Fetch-Dest` is a script, worker or XSLT load get `403`.
- Every response has `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`.
- Anything other than images, video, audio, plain text and PDF (for example SVG or HTML) is sent with
  `Content-Disposition: attachment`.

## Descriptors and NIP-94 tags (BUD-08)

Upload and mirror answer with a blob descriptor that includes a `nip94` tag list. When a thumbnail exists it is
advertised as a `thumb` tag.

When the operator has turned on EXIF stripping (off by default), JPEG, PNG and WebP uploads are cleaned before they
are stored. The stored blob then has a **different hash** from what you uploaded: the descriptor describes the
stored blob, and its `nip94` tags include `["ox", <original sha256>]`. Mirrored blobs are always stored
byte-identical.

## Errors and limits

Errors are an HTTP status plus an `X-Reason` header; the body carries the full text.

| Status | Typical cause |
| --- | --- |
| `400` | Bad header or query value, empty blob. |
| `401` | Missing, invalid or already-used auth token. |
| `403` | Not your blob, blocked hash, refused by a plugin's upload hook, or a script load. |
| `408` | The upload body stalled or trickled too slowly. |
| `411` | `HEAD /upload` without `X-Content-Length`. |
| `413` | Over the maximum upload size. |
| `415` | MIME type not allowed (or, with EXIF stripping on, metadata that couldn't be removed). |
| `429` | Per-IP or per-pubkey rate limit, or too many concurrent uploads from one address. |
| `503` | The server's upload memory budget is full, a plugin upload hook timed out, or the server is shutting down. |

Upload size, allowed MIME types, quotas and approval rules are runtime settings in the admin panel. The abuse
limits (concurrent uploads, uploads per minute, buffered bytes, mirror ports and timeout) are boot-time config; see the
[configuration reference](/relay/config/reference/).

:::tip[Extending uploads]
Plugins can accept or reject every upload and mirror with an
[`onBlobUpload` hook](/relay/build/plugin-hooks/#blob-upload-hooks), and use `ctx.blossom` to list, moderate or
delete blobs.
:::
