# @beamhop/blossom

Blossom media server (BUD-01/02/04/06/08/11/12) for beamhop.

```ts
import { createBlossom, createBlobDriver } from "@beamhop/blossom";
const blossom = await createBlossom(deps); // mount blossom.app at "/"
```

`createBlossomService(deps, options)` additionally accepts a custom `driver`, `useSharp: false`, a mirror `fetch`,
`allowPrivateMirror`, `mirrorTimeoutMs` (the whole mirror transfer, default 30 s), `mirrorPorts` (default `[80, 443]`), `uploadsPerMinutePerIp` /
`uploadsPerMinutePerPubkey` (default 60 each; IPv6 counted per /64), `maxConcurrentUploads` / `maxQueuedUploads`
(ingests at once / waiting, default 8 / 32; beyond that `503`), `maxBufferedUploadBytes` (request-body bytes held in
memory across all uploads + mirrors, default 256 MiB and never below 2 × `maxUploadBytes` + 1 MiB; beyond that `503`),
`maxConcurrentUploadsPerIp` (bodies being received per client, default 4; beyond that `429`), `uploadStallMs`
(default 15 s) and `minUploadBytesPerSec` (default 4 KiB/s after the first 30 s): stalled or trickling bodies get
`408`. The returned service also exposes `driver`, `sharp`, `block`, `unblock`, `blocklist`.

Admin actions (`setStatus`, `delete`, `deleteByPubkey`, `block`, `unblock`) take an optional last `{ ip }` (the
requester's address, as the admin API passes it): each writes an audit entry carrying it and emits the bus
`admin.action` event, like the admin API's own audit helper. Records carry `moderatedBy` (the admin who set the
current pending/blocked status; null when approved or held back by `requireApproval`, and kept when a held-back blob
is deleted and re-uploaded), blocklist entries `blockedBy` (for a moderated-to-blocked blob its owner deleted: that
moderator). `read()` returns the Content-Type to serve (JavaScript as `text/plain`).

The abuse limits can also be set by operators without code: `config.blossom.limits.<name>` in the config file, or
`BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_IP`, `…_UPLOADS_PER_MINUTE_PER_PUBKEY`, `…_MAX_CONCURRENT_UPLOADS`,
`…_MAX_QUEUED_UPLOADS`, `…_MAX_BUFFERED_UPLOAD_BYTES`, `…_MAX_UPLOADS_PER_IP` (= `maxConcurrentUploadsPerIp`),
`…_UPLOAD_STALL_MS`, `…_MIN_UPLOAD_BYTES_PER_SEC`, `…_MIRROR_PORTS` (comma-separated) and `…_MIRROR_TIMEOUT_MS`
(`mirrorTimeoutMs`; raise it for large mirrors from slow origins). `createBlossom(deps)` reads them from `deps.config`. An upload whose `Content-Length` can't fit the memory budget right now is refused with `503`
before its body is read. The per-IP limits key on the client address: **behind a reverse proxy enable
`server.trustProxy`**, or every client shares the proxy's address and one set of limits (the server logs a warning
the first time an upload arrives from a private address while `trustProxy` is off). Plugin `onBlobUpload` hooks run
before any blob lock is taken, so a hook may call `setStatus`/`delete`/`block` on the blob being uploaded; a block
that lands while hooks run is re-checked under the lock, so the blob is refused (`403`) rather than stored. Hooks run
after the blocklist and quota pre-checks, so over-quota or blocked uploads never reach them.

Quotas: a per-user `blossomQuota` wins over `settings.blossom.defaultQuotaBytes`, and **0 there means no storage at
all**; `null` falls back to the default, where 0 means unlimited.

Locks, the upload budgets and the used-delete-token cache are **per process**: run one beamhop process per database
(several instances sharing one database can race on the same blob, e.g. one process's orphan cleanup removing bytes
another just wrote). Used delete tokens are also kept in kv until they expire, so a restart doesn't re-enable replays.

## Routes
| Route | Notes |
|---|---|
| `GET/HEAD /<sha256>[.ext]` | Any extension (case-insensitive) returns the blob itself. Public for `approved` blobs. `pending` only for owners/staff, `blocked` only for staff (auth `t=get`), otherwise 404. Staff = config owners and users with an admin-panel role (viewer included) who aren't banned or deny-listed. Range (single; `If-Range` honoured against the ETag), ETag, 304 (`If-None-Match`, also `*`), immutable cache. Under Bun a blob proxied from S3 is sent chunked: the runtime drops the `Content-Length` of streamed bodies (HEAD still reports it; `publicUrl` redirects avoid it). Never loadable as code: requests with `Sec-Fetch-Dest` `script`, `worker`, `sharedworker`, `serviceworker`, `audioworklet`, `paintworklet` or `xslt` get `403`, and JavaScript types are served as `text/plain; charset=utf-8`, WebAssembly as `application/octet-stream` (the stored type is unchanged). Always `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` (inline-safe audio/video: `default-src 'none'; media-src 'self'`, since browsers won't play a sandboxed media document); anything but images/video/audio/plain text/PDF (e.g. SVG, HTML, XML) is sent with `Content-Disposition: attachment`. S3 with `publicUrl` → `307` redirect (inline-safe types only). A malformed or expired token is treated like no token (404 / public listing). |
| `GET/HEAD /thumb/<sha256>.webp` | 320px WebP thumbnail (only when sharp is available), same visibility rules as the blob. Advertised as the nip94 `thumb` tag. Kept outside `/<sha256>` so a hash URL never returns other bytes. |
| `PUT /upload` | Auth `t=upload` with an `x` tag matching the uploaded bytes (and `X-SHA-256` when sent), per BUD-11; a `server` tag alone isn't enough. No token (upload, delete, get or list) may expire more than 24 h after now or after its own `created_at`. Upload tokens are reusable until they expire, except that once the signer deletes the blob, their tokens for it signed before that delete token (both on the signer's own clock) get `401`, so a captured token can't put it back, also not as the EXIF-carrying original of a stripped upload through `/mirror`; an admin's removal does the same for every owner (tokens signed more than 30 s before it). Rate limited per IP and pubkey (`429`). `201` when newly stored, `200` when it already existed. |
| `HEAD /upload` | BUD-06 preflight. `X-SHA-256` required (else 400) with a matching auth `x` tag; `X-Content-Length` required (else 411); `X-Content-Type` optional. Same refusals as the upload: blocklisted or moderated-to-blocked hash (403), quota, a token voided by a delete. |
| `GET /list/<pubkey>` | `since`, `until`, `limit`, `cursor` (a malformed one is `400`). Unapproved blobs are only listed for the owner or staff (auth `t=list`). |
| `DELETE /<sha256>` | Auth `t=delete` with matching `x` tag; each delete token works once per blob it names (a replay against a re-uploaded blob gets `401`; a retry for a blob that is already gone gets `404`). A non-owner gets `403` for an approved blob and `404` for a pending/blocked one (as on GET). Removes the requester's ownership. Data is deleted when no owners remain; a blob a moderator blocked is added to the blocklist then, so re-uploading it is refused. |
| `PUT /mirror` | Auth `t=upload` with `x` tag(s). SSRF-checked (public addresses only, ports 80/443 by default via `blossom.limits.mirrorPorts` / `BEAMHOP_BLOSSOM_MIRROR_PORTS`, every redirect re-checked, DNS pinned), size/time/quota limited (refused before downloading when `Content-Length` doesn't fit), upstream errors are not echoed. Stored byte-identical, so EXIF is **not** stripped; when stripping is on and a stripped upload was blocked, mirroring its original (EXIF-carrying) bytes is refused too. The origin's `Content-Type` is used when valid (sniffed otherwise; unrecognised bytes, and SVG whatever it's labelled, keep it only for text). `201` when newly stored, `200` when it already existed. |
| `/media`, `/report` | BUD-05 / BUD-09 are not implemented: every method gets a `404` that carries the CORS headers (and `OPTIONS` a passing preflight), so browser clients probing for them see "not supported" rather than a network error. |

Errors use status codes plus an `X-Reason` header (printable ASCII; anything else becomes `?`, the body carries the full text).
SVG is recognised by its content, with or without an XML prolog, and stored as `image/svg+xml`; other XML is
`application/xml`. The `uploaded` field of an upload/mirror descriptor is the requester's own upload time, as in their
`/list`. Every route sets CORS headers itself. No app-wide middleware is
registered, so mounting at `/` doesn't affect other routes.

## EXIF stripping changes the hash (opt-in, deviates from BUD-02)
`settings.blossom.stripExif` is **off by default**: BUD-02 says the server MUST NOT modify uploaded blobs, so by default
uploads are stored byte-identical. Enabling it is a deliberate deviation from the spec for operators who prefer privacy
over hash stability. When enabled, JPEG/PNG/WebP uploads have their metadata removed **before** they are
stored. The descriptor returned by `PUT /upload` therefore describes the *stored* blob: its `sha256`, `size` and `url`
may differ from what the client uploaded. In that case `nip94` contains `["ox", <original sha256>]`. An auth `x` tag
(or `X-SHA-256` header) is checked against the hash of the bytes the client sent.

- With sharp: images that have EXIF/XMP/IPTC data or a non-default orientation are re-encoded in the same format.
  The orientation is applied with `.rotate()`. Clean images are left untouched.
- Without sharp: lossless pure-JS segment removal (JPEG APP1/APP13/COM, PNG text/eXIf/tIME chunks, WebP EXIF/XMP
  chunks). A non-default JPEG EXIF orientation is kept in a minimal EXIF segment holding only that tag.
- JPEG: anything after the primary image's end (MPF/MPO secondary images such as previews, stereo pairs, depth or
  HDR gain maps, which carry their own EXIF, often with GPS) is dropped, together with the MPF index. With sharp this
  also happens to an image sharp considers clean when something follows its end.
- AVIF and TIFF: with sharp they are re-encoded when they carry metadata (AVIF → AVIF, TIFF → TIFF). HEIC/HEIF would
  be re-encoded as **JPEG**, but the prebuilt sharp binaries (as in the Docker image) can't decode HEVC, so in
  practice HEIC/HEIF photos that carry EXIF/XMP are rejected with `415` and a message asking for JPEG/PNG/WebP. The
  same applies without sharp (and to every TIFF) — nothing is published with location data it couldn't remove.
- With sharp, images it considers clean are stored byte-identical (the client's hash keeps matching), except PNGs
  whose text chunks hold a metadata profile libvips doesn't see (`Raw profile type exif/xmp/iptc`, `XML:com.adobe.xmp`,
  which can carry GPS): those still get the pure-JS pass.
- Images larger than 50 MP are never decoded (decompression-bomb guard): no re-encoding, no thumbnail; the pure-JS
  pass still applies. At most two sharp jobs run at once.
- **Video is not stripped.** Phone videos (MP4/MOV) can carry location atoms (`©xyz`). If that matters for your
  relay, drop `video/*` from `allowedMimeTypes` or require approval.

sharp is loaded with a dynamic import. If it's missing, thumbnails and re-encoding are disabled.

## Storage
- `fs`: `<fsPath>/ab/cd/<sha256>` (+ `.thumb.webp`). Writes go to a temp file and are atomically renamed.
- `s3`: path-style `endpoint/bucket/<sha256>`, signed with aws4fetch. With `publicUrl` (public bucket/CDN):
  types that aren't inline-safe (SVG, HTML, …) are stored as `application/octet-stream` with
  `Content-Disposition: attachment`, and pending/blocked blobs are kept under an unguessable
  `quarantine-<hmac(secretAccessKey, sha256)>` key, moved to `<sha256>` only when approved (and back when
  blocked). Rotating `secretAccessKey` orphans quarantined objects, so approve or delete pending blobs first.
- Tables: `blossom_blobs` (incl. `moderated_by`), `blossom_owners`, `blossom_blocklist` (incl. `blocked_by`),
  `blossom_deletions` (owner deletions that void older upload tokens, also recorded for a stripped blob's originals;
  pruned after 24 h) and `blossom_stripped` (original → stored hash of stripped uploads, so a block on the stored blob
  refuses the original too; dropped once the stored blob is gone and neither hash is blocklisted).
