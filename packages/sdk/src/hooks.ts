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
}
export type BlobHookResult = { action: "accept" } | { action: "reject"; reason: string } | undefined | void;
export type BlobUploadHook = (blob: BlobUploadInfo, data: Uint8Array) => BlobHookResult | Promise<BlobHookResult>;

interface Entry<T> { fn: T; priority: number; owner: string }

/** Shared hook registry: plugins register, core/blossom execute. Lower priority runs first (default 100). */
export class HookRegistry {
  private write: Entry<WritePolicy>[] = [];
  private query: Entry<QueryHook>[] = [];
  private visibility: Entry<VisibilityHook>[] = [];
  private blob: Entry<BlobUploadHook>[] = [];

  private add<T>(list: Entry<T>[], fn: T, owner: string, priority = 100) {
    const e = { fn, owner, priority };
    list.push(e);
    list.sort((a, b) => a.priority - b.priority);
    return () => {
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
    };
  }
  onWrite(fn: WritePolicy, owner = "core", priority?: number) { return this.add(this.write, fn, owner, priority); }
  onQuery(fn: QueryHook, owner = "core", priority?: number) { return this.add(this.query, fn, owner, priority); }
  onVisibility(fn: VisibilityHook, owner = "core", priority?: number) { return this.add(this.visibility, fn, owner, priority); }
  onBlobUpload(fn: BlobUploadHook, owner = "core", priority?: number) { return this.add(this.blob, fn, owner, priority); }
  /** Remove all hooks registered by an owner (plugin disable). */
  removeOwner(owner: string) {
    for (const list of [this.write, this.query, this.visibility, this.blob] as Entry<unknown>[][]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1);
    }
  }

  async runWrite(event: NostrEvent, ctx: WriteContext): Promise<{ event: NostrEvent; result: "accept" | "reject" | "shadow" | "next"; reason?: string }> {
    let current = event;
    for (const h of this.write) {
      let r: WritePolicyResult;
      try { r = await h.fn(current, ctx); } catch (err) {
        return { event: current, result: "reject", reason: `error: policy ${h.owner} failed` };
      }
      if (!r || r.action === "next") continue;
      if (r.action === "replace") { current = r.event; continue; }
      if (r.action === "reject") return { event: current, result: "reject", reason: r.reason };
      return { event: current, result: r.action };
    }
    return { event: current, result: "next" };
  }

  async runQuery(filters: Filter[], ctx: ReadContext): Promise<{ filters: Filter[] } | { reject: string }> {
    let current = filters;
    for (const h of this.query) {
      const r = await h.fn(current, ctx);
      if (!r) continue;
      if (Array.isArray(r)) current = r;
      else return r;
    }
    return { filters: current };
  }

  isVisible(event: NostrEvent, ctx: ReadContext): boolean {
    for (const h of this.visibility) {
      try { if (!h.fn(event, ctx)) return false; } catch { return false; }
    }
    return true;
  }

  async runBlobUpload(info: BlobUploadInfo, data: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (const h of this.blob) {
      const r = await h.fn(info, data);
      if (!r) continue;
      if (r.action === "reject") return { ok: false, reason: r.reason };
      if (r.action === "accept") break;
    }
    return { ok: true };
  }

  get counts() {
    return { write: this.write.length, query: this.query.length, visibility: this.visibility.length, blob: this.blob.length };
  }
}
