import type { NostrEvent, Filter } from "./nostr";
import type { RuntimeSettings } from "./config";
import type { AuditEntry, UserRecord } from "./stores";
import type { Logger } from "./logger";

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
  "user.deleted": { pubkey: string; actor: string };
  "settings.changed": { settings: RuntimeSettings; actor: string };
  "ip.rules.changed": { actor: string };
  "admin.action": { entry: Omit<AuditEntry, "id"> };
  "alert": { level: "info" | "warning" | "critical"; title: string; message: string; url?: string };
}
export type EventSource = "ws" | "api" | "import" | "sync" | "relay" | "plugin";

type Handler<T> = (payload: T) => unknown;

/** How often the same (event, handler) failure is logged; repeats in between are counted and reported with the next one. */
const ERROR_LOG_INTERVAL_MS = 60_000;

export interface EventBusOptions {
  /** where handler failures are reported (default console.error) */
  logger?: Pick<Logger, "error">;
}

export class EventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<any>>>();
  /** per handler, per event: when a failure was last logged and how many were swallowed since */
  private failures = new WeakMap<Handler<any>, Map<string, { at: number; suppressed: number }>>();
  private logger?: Pick<Logger, "error">;

  constructor(opts: EventBusOptions = {}) {
    this.logger = opts.logger;
  }

  /** Route handler-failure logs through a logger. */
  setLogger(logger: Pick<Logger, "error">) {
    this.logger = logger;
  }

  on<K extends keyof BusEvents>(name: K, fn: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private fail(name: string, fn: Handler<any>, err: unknown) {
    let byEvent = this.failures.get(fn);
    if (!byEvent) this.failures.set(fn, (byEvent = new Map()));
    const now = Date.now();
    const f = byEvent.get(name);
    if (f && now - f.at < ERROR_LOG_INTERVAL_MS) {
      f.suppressed++;
      return;
    }
    const suppressed = f?.suppressed ?? 0;
    byEvent.set(name, { at: now, suppressed: 0 });
    try {
      const msg = `[bus] handler ${fn.name || "(anonymous)"} for ${name} failed`;
      const extra = suppressed ? { suppressedSinceLastLog: suppressed } : {};
      if (this.logger) this.logger.error(msg, { error: err, ...extra });
      else console.error(msg, err, ...(suppressed ? [extra] : []));
    } catch {}
  }

  /**
   * Synchronous, error-isolated fan-out. Handlers must be cheap; defer heavy work.
   * Async handlers are not awaited, but their rejections are caught so they can't crash the process.
   * A failing handler is logged at most once a minute per event.
   */
  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) {
      try {
        const r = fn(payload);
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, (err) => this.fail(name, fn, err));
      } catch (err) {
        this.fail(name, fn, err);
      }
    }
  }
}
