# @beamhop/blossom

Blossom media server (BUD-01/02/04/06, BUD-11 auth) for beamhop.

```ts
import { createBlossom, createBlobDriver } from "@beamhop/blossom";
const blossom = await createBlossom(deps); // mount blossom.app at "/"
```

`createBlossomService(deps, options)` additionally accepts a custom `driver`, `useSharp: false`, a mirror `fetch`,
`allowPrivateMirror` and `mirrorTimeoutMs`. The returned service also exposes `driver`, `sharp`, `block`, `unblock`, `blocklist`.

## Routes
| Route | Notes |
|---|---|
| `GET/HEAD /<sha256>[.ext]` | Public for `approved` blobs. `pending` only for owners/staff, `blocked` only for staff (auth `t=get`), otherwise 404. Range (single), ETag, 304, immutable cache. S3 with `publicUrl` → `307` redirect. |
| `GET /<sha256>.thumb.webp` or `GET /<sha256>?thumb=1` | 320px WebP thumbnail (only when sharp is available). |
| `PUT /upload` | Auth `t=upload`. `x` tags optional, but must match the uploaded bytes when present. |
| `HEAD /upload` | BUD-06 preflight using `X-SHA-256`, `X-Content-Length` (required, else 411), `X-Content-Type`. |
| `GET /list/<pubkey>` | `since`, `until`, `limit`, `cursor`. Unapproved blobs are only listed for the owner or staff (auth `t=list`). |
| `DELETE /<sha256>` | Auth `t=delete` with matching `x` tag. Removes the requester's ownership. Data is deleted when no owners remain. |
| `PUT /mirror` | Auth `t=upload` with `x` tag(s). SSRF-checked and size/time limited. Stored byte-identical, so EXIF is **not** stripped. |

Errors use status codes plus an `X-Reason` header. Every route sets CORS headers itself. No app-wide middleware is
registered, so mounting at `/` doesn't affect other routes.

## EXIF stripping changes the hash
When `settings.blossom.stripExif` is enabled, JPEG/PNG/WebP uploads have their metadata removed **before** they are
stored. The descriptor returned by `PUT /upload` therefore describes the *stored* blob: its `sha256`, `size` and `url`
may differ from what the client uploaded. In that case `nip94` contains `["ox", <original sha256>]`. An auth `x` tag
(or `X-SHA-256` header) is checked against the hash of the bytes the client sent.

- With sharp: images that have EXIF/XMP/IPTC data or a non-default orientation are re-encoded in the same format.
  The orientation is applied with `.rotate()`. Clean images are left untouched.
- Without sharp: lossless pure-JS segment removal (JPEG APP1/APP13/COM, PNG text/eXIf/tIME chunks, WebP EXIF/XMP
  chunks). The EXIF orientation is lost.

sharp is loaded with a dynamic import. If it's missing, thumbnails and re-encoding are disabled.

## Storage
- `fs`: `<fsPath>/ab/cd/<sha256>` (+ `.thumb.webp`). Writes go to a temp file and are atomically renamed.
- `s3`: path-style `endpoint/bucket/<sha256>`, signed with aws4fetch.
- Tables: `blossom_blobs`, `blossom_owners`, `blossom_blocklist`.
