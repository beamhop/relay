import type { NostrEvent, Filter } from "./nostr";
import type { RuntimeSettings } from "./config";
import type { AuditEntry, UserRecord } from "./stores";

export type RejectCode =
  | "invalid" | "blocked" | "rate-limited" | "pow" | "auth-required" | "restricted" | "duplicate" | "error" | "policy" | "too-large";

/** All cross-package events. Metrics, admin SSE and plugins subscribe here. */
export interface BusEvents {
  "connection.open": { connId: string; ip: string; userAgent?: string; at: number };
  "connection.close": { connId: string; ip: string; durationMs: number; at: number };
  "connection.auth": { connId: string; pubkey: string; ip: string };
  "event.accepted": { event: NostrEvent; status: "saved" | "replaced" | "ephemeral"; connId?: string; ip?: string; source: EventSource };
  "event.rejected": { event?: NostrEvent; code: RejectCode; reason: string; connId?: string; ip?: string; pubkey?: string; source: EventSource };
  "event.broadcast": { event: NostrEvent; recipients: number };
  "event.deleted": { ids: string[]; actor: string; reason?: string };
  "req.executed": { connId: string; subId: string; filters: Filter[]; results: number; durationMs: number; ip: string };
  "message.in": { connId: string; type: string; bytes: number };
  "message.out": { connId: string; type: string; bytes: number };
  "blob.uploaded": { sha256: string; size: number; type: string; pubkey: string };
  "blob.deleted": { sha256: string; actor: string };
  "blob.served": { sha256: string; size: number; ip: string };
  "report.created": { event: NostrEvent };
  "user.updated": { pubkey: string; user: UserRecord; actor: string };
  "settings.changed": { settings: RuntimeSettings; actor: string };
  "ip.rules.changed": { actor: string };
  "admin.action": { entry: Omit<AuditEntry, "id"> };
  "alert": { level: "info" | "warning" | "critical"; title: string; message: string; url?: string };
}
export type EventSource = "ws" | "api" | "import" | "sync" | "relay" | "plugin";

type Handler<T> = (payload: T) => unknown;

export class EventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<any>>>();
  on<K extends keyof BusEvents>(name: K, fn: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  /**
   * Synchronous, error-isolated fan-out. Handlers must be cheap; defer heavy work.
   * Async handlers are not awaited, but their rejections are caught so they can't crash the process.
   */
  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    const fail = (err: unknown) => console.error(`[bus] handler for ${String(name)} failed`, err);
    for (const fn of set) {
      try {
        const r = fn(payload);
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, fail);
      } catch (err) {
        fail(err);
      }
    }
  }
}
