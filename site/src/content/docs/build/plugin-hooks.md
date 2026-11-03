---
title: Hooks
description: Reference for plugin write, query, visibility and blob upload hooks — signatures, return values, ordering, time budgets and failure behaviour.
sidebar:
  order: 6
---

Hooks let a plugin take part in the relay's own decisions. There are four kinds:

| Hook | Runs on | Can |
| --- | --- | --- |
| `onWrite` | every incoming event | accept, reject, shadow-drop or replace it |
| `onQuery` | `REQ`, `COUNT` and `NEG-OPEN` filters | rewrite or reject them |
| `onVisibility` | each event a reader would receive | hide it |
| `onBlobUpload` | each Blossom upload and mirror | accept or reject it |

All four are registered on `ctx.hooks` and return a function that unregisters the hook. They are also removed
automatically when the plugin is disabled.

## Ordering and options

```ts
interface HookOptions {
  priority?: number;   // lower runs first (default 100)
  timeoutMs?: number;  // budget for one call; 0 = unlimited. Not used for visibility hooks.
}

ctx.hooks.onWrite(fn);                        // priority 100
ctx.hooks.onWrite(fn, 50);                    // a bare number is the priority
ctx.hooks.onWrite(fn, { priority: 50, timeoutMs: 500 });
```

Hooks with equal priority run in registration order. `spam-filter` registers at priority 50 so it runs before
plugins with the default.

Hook lists are copy-on-write: enabling or disabling a plugin never changes the hooks an event already in flight runs
through.

## Time budgets and failures

Async hooks run against a time budget. When it runs out, the hook's `AbortSignal` fires and whatever it returns
later is ignored.

| Hook | Default budget | On timeout | On thrown error |
| --- | --- | --- | --- |
| write | 2 s | **fails open**: treated as no opinion | event rejected: `error: policy plugin:<name> failed` |
| query | 2 s | read refused: `error: query policy plugin:<name> timed out` | read refused |
| blob | 30 s | upload refused with `503` | upload refused with `500` |
| visibility | none (must be synchronous) | — | event hidden |

Every timeout and error is counted in the `hook_incidents_total` metric and raises a coalesced admin alert.

Write hooks fail open on timeout so a hung plugin can't stall publishing. Pass the signal on to anything slow you
call, so the work actually stops:

```ts
ctx.hooks.onWrite(async (event, wctx) => {
  const res = await fetch(`https://example.com/check/${event.pubkey}`, { signal: wctx.signal });
  if (res.status === 403) return { action: "reject", reason: "blocked: pubkey is on the external deny list" };
});
```

Hooks that return synchronously don't start a timer at all.

## Write hooks

```ts
type WritePolicy = (event: NostrEvent, ctx: WriteContext) => WritePolicyResult | Promise<WritePolicyResult>;

interface WriteContext {
  conn?: ConnectionInfo;    // absent for events that didn't arrive over a WebSocket
  source: "ws" | "api" | "import" | "sync" | "relay" | "plugin";
  signal?: AbortSignal;
}

interface ConnectionInfo {
  id: string;
  ip: string;
  userAgent?: string;
  origin?: string;
  authedPubkeys: ReadonlySet<string>;   // NIP-42 authenticated pubkeys
  connectedAt: number;
}
```

### Return values

| Return | Effect |
| --- | --- |
| `undefined`, nothing, or `{ action: "next" }` | No opinion. The next hook runs. |
| `{ action: "reject", reason }` | `OK false` with `reason`. Prefix it like NIP-01 (`"blocked: …"`). Stops the chain. |
| `{ action: "shadow" }` | `OK true`, but the event is neither stored nor broadcast. Stops the chain. |
| `{ action: "accept" }` | Stops the plugin chain and **skips the built-in content policy** (kind allow/block lists, word and regex filters). |
| `{ action: "replace", event }` | The pipeline continues with a different event, which must already be signed and valid. Later hooks see the replacement. |

`accept` doesn't bypass everything: signature checks, bans, the access mode and rate limits run before plugin hooks
and still apply.

### Where write hooks run

Write hooks run late in the pipeline, after the cheap and security-relevant checks:

1. parse, size limits, id and signature verification, `created_at` bounds
2. NIP-40 expiration, NIP-13 proof of work
3. bans, deny list, vanished pubkeys, mutes
4. access mode (public, whitelist, invite, auth-required) and NIP-70
5. duplicate check, then rate limits
6. **plugin write hooks**
7. built-in content policy (skipped after `accept`)
8. special kinds (deletions, vanish requests, reports, NIP-29 group events), then store and broadcast

So a write hook never sees invalid events, events from banned users, or events that were already stored.

### Example: score and filter

From `spam-filter`, slightly trimmed:

```ts
ctx.hooks.onWrite(async (event: NostrEvent, wctx: WriteContext) => {
  const s = ctx.settings.get();
  if (wctx.source !== "ws" && wctx.source !== "api") return undefined;   // skip imports, sync, relay-signed
  if (event.kind >= 20000 && event.kind < 30000) return undefined;       // ephemeral
  const info = await userInfo(event.pubkey);                               // cached ctx.users.get()
  if (s.exemptAdmins && info.admin) return undefined;
  const v = scorer.score(event, { firstSeenAt: info.firstSeenAt });
  if (v.score < s.threshold) return undefined;
  return s.action === "shadow"
    ? { action: "shadow" }
    : { action: "reject", reason: `blocked: looks like spam (${v.reasons.join(", ")})` };
}, 50);
```

Write hooks are on the publish path, so keep them fast. Cache lookups, and don't write to the database once per
event: buffer and flush from a job, as `hello` does.

## Query hooks

```ts
type QueryHook = (filters: Filter[], ctx: ReadContext) => QueryHookResult | Promise<QueryHookResult>;
type QueryHookResult = Filter[] | { reject: string } | undefined | void;

interface ReadContext {
  conn?: ConnectionInfo;
  subId?: string;
  source: "ws" | "api" | "count" | "sync";   // REQ, API, COUNT, NEG-OPEN
  signal?: AbortSignal;
}
```

| Return | Effect |
| --- | --- |
| `undefined` / nothing | No change. |
| `Filter[]` | Replaces the filters. The next hook sees your version. |
| `{ reject: "…" }` | The read is refused (`CLOSED` with that reason). Stops the chain. |

Example from `hello`, clamping every filter's `limit`:

```ts
ctx.hooks.onQuery((filters) => {
  const max = ctx.settings.get().maxQueryLimit;
  if (!filters.some((f) => (f.limit ?? 0) > max)) return undefined;
  return filters.map((f) => (f.limit !== undefined && f.limit > max ? { ...f, limit: max } : f));
});
```

## Visibility hooks

```ts
type VisibilityHook = (event: NostrEvent, ctx: ReadContext) => boolean;
```

Return `false` to hide an event from this reader. The event stays stored. Visibility hooks are called for stored
results and for live broadcasts, per event and per reader, so they **must be synchronous and fast**: no I/O. Keep
whatever they need in memory, and refresh it from a job or a bus listener. A hook that throws hides the event.

```ts
ctx.hooks.onVisibility((event) => !ctx.settings.get().hiddenKinds.includes(event.kind));
```

The relay keeps results honest with a visibility hook in place:

- A `REQ` still returns `limit` *visible* events: if hidden events filled part of a page, older pages are read (up to
  5000 extra rows per `REQ`), so the result size doesn't reveal how many were hidden.
- `COUNT` and NIP-77 `NEG-OPEN` apply the hook too, checking candidates one by one (up to 50,000; 1,000 for search
  counts). A count that can't be computed exactly is refused rather than approximated.

That makes counting and sync slower on relays with a visibility hook, so only register one if you need it.

## Blob upload hooks

```ts
type BlobUploadHook = (blob: BlobUploadInfo, data: Uint8Array) => BlobHookResult | Promise<BlobHookResult>;

interface BlobUploadInfo {
  sha256: string;
  size: number;
  type: string;      // the MIME type the blob will be stored with
  pubkey: string;    // the uploader
  ip?: string;
  signal?: AbortSignal;
}

type BlobHookResult = { action: "accept" } | { action: "reject"; reason: string } | undefined | void;
```

| Return | Effect |
| --- | --- |
| `undefined` / nothing | No opinion. |
| `{ action: "accept" }` | Accepted; remaining blob hooks are skipped. |
| `{ action: "reject", reason }` | The upload is refused with `403` and `reason`. |

They run for `PUT /upload` and `PUT /mirror`, after the blocklist and quota pre-checks, so over-quota or blocked
uploads never reach them. You get the full bytes in `data`.

```ts
ctx.hooks.onBlobUpload((blob) => {
  if (blob.type === "image/gif" && blob.size > 5 * 1024 * 1024) {
    return { action: "reject", reason: "GIFs over 5 MB are not accepted" };
  }
});
```

Blob hooks run before any lock on the blob is taken, so a hook may call `ctx.blossom.setStatus`, `delete` or `block`
on the blob being uploaded. A block that lands while hooks run is re-checked under the lock, so the upload is refused
(`403`) rather than stored.
