import type { Filter, NostrEvent } from "./nostr";
import type { EventSource } from "./bus";

export interface ConnectionInfo {
  id: string;
  ip: string;
  userAgent?: string;
  origin?: string;
  /** NIP-42 authenticated pubkeys */
  authedPubkeys: ReadonlySet<string>;
  connectedAt: number;
}

export interface WriteContext {
  conn?: ConnectionInfo;
  source: EventSource;
  /** Set by HookRegistry: aborted when this hook's time budget runs out (its verdict is ignored from then on). */
  signal?: AbortSignal;
}

/**
 * - accept: stop plugin chain, skip built-in *content* policies (kind lists, word filters). Bans/sig/limits still apply.
 * - reject: OK false with reason (prefix like "blocked: ..." recommended)
 * - shadow: respond OK true but do not store/broadcast
 * - replace: continue pipeline with a different (already signed & valid) event
 * - undefined / {action:"next"}: no opinion
 */
export type WritePolicyResult =
  | { action: "accept" }
  | { action: "reject"; reason: string }
  | { action: "shadow" }
  | { action: "replace"; event: NostrEvent }
  | { action: "next" }
  | undefined
  | void;
export type WritePolicy = (event: NostrEvent, ctx: WriteContext) => WritePolicyResult | Promise<WritePolicyResult>;

export interface ReadContext {
  conn?: ConnectionInfo;
  subId?: string;
  source: "ws" | "api" | "count" | "sync";
  /** Set by HookRegistry for query hooks: aborted when this hook's time budget runs out. */
  signal?: AbortSignal;
}
/** Return modified filters, a rejection, or undefined for no change. */
export type QueryHookResult = Filter[] | { reject: string } | undefined | void;
export type QueryHook = (filters: Filter[], ctx: ReadContext) => QueryHookResult | Promise<QueryHookResult>;
/** Per-event visibility for stored results and live broadcasts. Return false to hide. Must be sync & fast. */
export type VisibilityHook = (event: NostrEvent, ctx: ReadContext) => boolean;

export interface BlobUploadInfo {
  sha256: string;
  size: number;
  type: string;
  pubkey: string;
  ip?: string;
  /** Set by HookRegistry: aborted when this hook's time budget runs out. */
  signal?: AbortSignal;
}
export type BlobHookResult = { action: "accept" } | { action: "reject"; reason: string } | undefined | void;
export type BlobUploadHook = (blob: BlobUploadInfo, data: Uint8Array) => BlobHookResult | Promise<BlobHookResult>;

export type HookKind = "write" | "query" | "visibility" | "blob";

/** Per-registration options. A bare number is the priority (the original signature). */
export interface HookOptions {
  /** lower runs first (default 100) */
  priority?: number;
  /** time budget of one call in ms (default: the registry's per-kind default; 0 = unlimited). Not used for visibility hooks. */
  timeoutMs?: number;
}

/** A hook that ran out of time or threw; `owner` names the plugin (or "core"). */
export interface HookIncident {
  kind: HookKind;
  owner: string;
  type: "timeout" | "error";
  /** the budget that ran out (type "timeout") */
  timeoutMs?: number;
  error?: unknown;
}

export class HookError extends Error {
  constructor(message: string, readonly kind: HookKind, readonly owner: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HookError";
  }
}
export class HookTimeoutError extends HookError {
  constructor(kind: HookKind, owner: string, readonly timeoutMs: number) {
    super(`${kind} hook of ${owner} timed out after ${timeoutMs} ms`, kind, owner);
    this.name = "HookTimeoutError";
  }
}

export interface HookRegistryOptions {
  /** default per-call budgets in ms (write/query 2 s, blob 30 s) */
  timeouts?: Partial<Record<Exclude<HookKind, "visibility">, number>>;
  /** called for every hook timeout or thrown error (log / metric / alert) */
  onIncident?: (incident: HookIncident) => void;
}

interface Entry<T> { fn: T; priority: number; owner: string; timeoutMs?: number }
type Lists = { write: Entry<WritePolicy>[]; query: Entry<QueryHook>[]; visibility: Entry<VisibilityHook>[]; blob: Entry<BlobUploadHook>[] };

const DEFAULT_TIMEOUTS = { write: 2_000, query: 2_000, blob: 30_000 };
const TIMED_OUT: unique symbol = Symbol("timed out");
const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === "function";
const noop = () => {};

/**
 * Shared hook registry: plugins register, core/blossom execute. Lower priority runs first (default 100).
 *
 * Lists are copy-on-write: add/remove replace the array, so a run iterates the snapshot it started with and a
 * plugin disabled mid-event can't make the next hook be skipped.
 *
 * Every async call has a time budget. A hook that runs over gets its `signal` aborted, whatever it settles with
 * later is ignored, and an incident is reported. On timeout write hooks fail open (treated as no opinion, so a
 * hung plugin can't stall publishing); query and blob hooks fail closed. A thrown error fails closed for every kind.
 */
export class HookRegistry {
  private lists: Lists = { write: [], query: [], visibility: [], blob: [] };
  private timeouts: Record<Exclude<HookKind, "visibility">, number>;
  private incidentListeners = new Set<(i: HookIncident) => void>();

  constructor(opts: HookRegistryOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    if (opts.onIncident) this.incidentListeners.add(opts.onIncident);
  }

  /** Subscribe to hook timeouts/errors (e.g. to log, count and alert). Returns unsubscribe. */
  onIncident(fn: (i: HookIncident) => void): () => void {
    this.incidentListeners.add(fn);
    return () => this.incidentListeners.delete(fn);
  }

  private add<K extends HookKind>(kind: K, fn: Lists[K][number]["fn"], owner: string, opts?: number | HookOptions) {
    const o = typeof opts === "number" ? { priority: opts } : (opts ?? {});
    const e: Entry<unknown> = { fn, owner, priority: o.priority ?? 100, timeoutMs: o.timeoutMs };
    const lists = this.lists as Record<HookKind, Entry<unknown>[]>;
    // stable sort: equal priorities keep registration order
    lists[kind] = [...lists[kind], e].sort((a, b) => a.priority - b.priority);
    return () => {
      if (lists[kind].includes(e)) lists[kind] = lists[kind].filter((x) => x !== e);
    };
  }
  onWrite(fn: WritePolicy, owner = "core", opts?: number | HookOptions) { return this.add("write", fn, owner, opts); }
  onQuery(fn: QueryHook, owner = "core", opts?: number | HookOptions) { return this.add("query", fn, owner, opts); }
  onVisibility(fn: VisibilityHook, owner = "core", opts?: number | HookOptions) { return this.add("visibility", fn, owner, opts); }
  onBlobUpload(fn: BlobUploadHook, owner = "core", opts?: number | HookOptions) { return this.add("blob", fn, owner, opts); }
  /** Remove all hooks registered by an owner (plugin disable). Runs already in progress finish on their snapshot. */
  removeOwner(owner: string) {
    const lists = this.lists as Record<HookKind, Entry<unknown>[]>;
    for (const kind of ["write", "query", "visibility", "blob"] as const) {
      if (lists[kind].some((e) => e.owner === owner)) lists[kind] = lists[kind].filter((e) => e.owner !== owner);
    }
  }

  private incident(i: HookIncident) {
    for (const fn of this.incidentListeners) {
      try {
        fn(i);
      } catch {}
    }
  }

  /**
   * Calls one hook within its time budget. Sync results come back without a timer. Thrown errors and rejections
   * propagate; on timeout the hook's signal is aborted and TIMED_OUT is returned.
   */
  private async call<R>(kind: Exclude<HookKind, "visibility">, h: Entry<unknown>, invoke: (signal: AbortSignal) => R | PromiseLike<R>): Promise<R | typeof TIMED_OUT> {
    const ac = new AbortController();
    const r = invoke(ac.signal);
    if (!isThenable(r)) return r;
    const ms = h.timeoutMs ?? this.timeouts[kind];
    if (!(ms > 0) || ms === Infinity) return r;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(resolve, ms, TIMED_OUT);
    });
    try {
      const v = await Promise.race([r, expired]);
      if (v === TIMED_OUT) {
        // the hook keeps running; whatever it settles with later is dropped
        Promise.resolve(r).then(noop, noop);
        ac.abort(new HookTimeoutError(kind, h.owner, ms));
        this.incident({ kind, owner: h.owner, type: "timeout", timeoutMs: ms });
      }
      return v;
    } finally {
      clearTimeout(timer);
    }
  }

  async runWrite(event: NostrEvent, ctx: WriteContext): Promise<{ event: NostrEvent; result: "accept" | "reject" | "shadow" | "next"; reason?: string }> {
    let current = event;
    for (const h of this.lists.write) {
      let r: WritePolicyResult | typeof TIMED_OUT;
      try {
        r = await this.call("write", h, (signal) => h.fn(current, { ...ctx, signal }));
      } catch (err) {
        this.incident({ kind: "write", owner: h.owner, type: "error", error: err });
        return { event: current, result: "reject", reason: `error: policy ${h.owner} failed` };
      }
      // fail open: a hung policy must not stall publishing (the incident raises an alert)
      if (r === TIMED_OUT || !r || r.action === "next") continue;
      if (r.action === "replace") { current = r.event; continue; }
      if (r.action === "reject") return { event: current, result: "reject", reason: r.reason };
      return { event: current, result: r.action };
    }
    return { event: current, result: "next" };
  }

  async runQuery(filters: Filter[], ctx: ReadContext): Promise<{ filters: Filter[] } | { reject: string }> {
    let current = filters;
    for (const h of this.lists.query) {
      let r: QueryHookResult | typeof TIMED_OUT;
      try {
        r = await this.call("query", h, (signal) => h.fn(current, { ...ctx, signal }));
      } catch (err) {
        this.incident({ kind: "query", owner: h.owner, type: "error", error: err });
        return { reject: `error: query policy ${h.owner} failed` };
      }
      if (r === TIMED_OUT) return { reject: `error: query policy ${h.owner} timed out` };
      if (!r) continue;
      if (Array.isArray(r)) current = r;
      else return r;
    }
    return { filters: current };
  }

  isVisible(event: NostrEvent, ctx: ReadContext): boolean {
    for (const h of this.lists.visibility) {
      try { if (!h.fn(event, ctx)) return false; } catch { return false; }
    }
    return true;
  }

  /** Throws HookError (HookTimeoutError on timeout) naming the hook's owner; callers answer with a server error. */
  async runBlobUpload(info: BlobUploadInfo, data: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (const h of this.lists.blob) {
      let r: BlobHookResult | typeof TIMED_OUT;
      try {
        r = await this.call("blob", h, (signal) => h.fn({ ...info, signal }, data));
      } catch (err) {
        this.incident({ kind: "blob", owner: h.owner, type: "error", error: err });
        throw new HookError(`blob hook of ${h.owner} failed: ${err instanceof Error ? err.message : String(err)}`, "blob", h.owner, { cause: err });
      }
      if (r === TIMED_OUT) throw new HookTimeoutError("blob", h.owner, h.timeoutMs ?? this.timeouts.blob);
      if (!r) continue;
      if (r.action === "reject") return { ok: false, reason: r.reason };
      if (r.action === "accept") break;
    }
    return { ok: true };
  }

  get counts() {
    const l = this.lists;
    return { write: l.write.length, query: l.query.length, visibility: l.visibility.length, blob: l.blob.length };
  }
}
