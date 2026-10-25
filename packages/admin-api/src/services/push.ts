import { lookup } from "node:dns/promises";
import webpush from "web-push";
import type { AdminApiDeps, Permission, PushTopic } from "@beamhop/sdk";
import { isForbiddenDestination } from "../util/ip";
import { kvGetOrCreate } from "../util/kv";
import { permissionsFor, type RoleService } from "./roles";

/** Topics the server sends. */
export const PUSH_TOPICS = ["reports", "alerts"] as const satisfies readonly PushTopic[];
export type SentPushTopic = (typeof PUSH_TOPICS)[number];
const TOPIC_PERMISSION: Record<SentPushTopic, Permission> = {
  reports: "reports.view",
  alerts: "dashboard.view",
};

/** max push subscriptions (devices) per admin */
export const MAX_SUBSCRIPTIONS_PER_ADMIN = 20;
/** how often (sec) notify() deletes the devices of ended sessions (it skips them on every send regardless) */
const PRUNE_INTERVAL_SEC = 60;
/** pushes in flight at once, across all notifications (each is a DNS lookup plus an HTTPS request) */
export const PUSH_CONCURRENCY = 8;
/** a single delivery (lookup included) is given up after this long */
export const PUSH_TIMEOUT_MS = 15_000;
/**
 * A device is dropped after this many deliveries in a row refused with 400/401/403 (a broken or foreign subscription,
 * VAPID keys that changed): unlike 404/410 one such answer may be transient, an unbroken run of them is not.
 */
export const MAX_PUSH_FAILURES = 5;
const PERMANENT_FAILURES = new Set([400, 401, 403]);

/**
 * Push services used by browsers today: Chromium/Samsung/Opera (FCM), Edge (WNS), Firefox (Mozilla autopush),
 * Safari (Apple). Subscriptions may only point here — otherwise any admin could make the server POST to
 * internal hosts (SSRF) every time an anonymous user files a report.
 */
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx) && host.length > sfx.length);
}

/**
 * Rate-limits a stream of notifications to one per `intervalMs`: the first one after a quiet period goes out right away
 * (`offer()` → true, sent with its own details); those arriving while the interval runs are only counted and sent as one
 * digest (`flush(count)`) when it ends, which starts another interval. So a flood of anonymous reports costs every admin
 * device one push per interval, never one per report. Timer-based only (no clock), unref'd.
 */
export class PushCoalescer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = 0;
  /** `onIdle`: an interval ended with nothing to flush (the next offer goes out right away again) */
  constructor(
    private readonly intervalMs: number,
    private readonly flush: (count: number) => void,
    private readonly onIdle?: () => void,
  ) {}

  offer(): boolean {
    if (this.timer) {
      this.pending++;
      return false;
    }
    this.arm();
    return true;
  }

  /** Stops the timer; counted notifications are dropped. */
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = 0;
  }

  private arm() {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.pending) return this.onIdle?.();
      const n = this.pending;
      this.pending = 0;
      this.arm();
      this.flush(n);
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/**
 * One PushCoalescer per key (alerts: per level and title), so a burst of one kind of alert (a word filter matching every
 * event of a spam wave) costs one push plus a digest per interval while a different alert still goes out at once. Idle
 * keys are dropped; past `maxKeys` distinct keys in flight, further new keys are not pushed (`offer` → false, not counted).
 */
export class KeyedPushCoalescer {
  private readonly windows = new Map<string, PushCoalescer>();
  constructor(
    private readonly intervalMs: number,
    private readonly flush: (key: string, count: number) => void,
    private readonly maxKeys = 100,
  ) {}

  offer(key: string): boolean {
    let w = this.windows.get(key);
    if (!w) {
      if (this.windows.size >= this.maxKeys) return false;
      w = new PushCoalescer(this.intervalMs, (n) => this.flush(key, n), () => this.windows.delete(key));
      this.windows.set(key, w);
    }
    return w.offer();
  }

  get size() {
    return this.windows.size;
  }

  dispose() {
    for (const w of this.windows.values()) w.dispose();
    this.windows.clear();
  }
}

/** Runs at most `limit` tasks at once; the rest wait in order. */
class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // a finishing task hands its slot straight to the next waiter, so a new caller can't slip in between
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}
export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}
interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type PushSender = (sub: PushSubscriptionInput, payload: string, vapid: Vapid) => Promise<void>;

interface PushRow {
  endpoint: string;
  pubkey: string;
  subscription: string;
  topics: string;
  failures: number;
}

const defaultSender: PushSender = async (sub, payload, vapid) => {
  // defence in depth against split-horizon DNS for the allow-listed hosts (web-push itself never follows redirects)
  const host = new URL(sub.endpoint).hostname;
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isForbiddenDestination(a.address))) throw new Error(`push endpoint ${host} resolves to a private address`);
  await webpush.sendNotification(sub, payload, {
    TTL: 3600,
    timeout: 10_000,
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
};

export class PushService {
  private vapid: Vapid | null = null;
  private lastPrune = 0;
  /** overridable for tests */
  sender: PushSender = defaultSender;
  /** per-delivery timeout (ms), overridable for tests */
  timeoutMs = PUSH_TIMEOUT_MS;
  private readonly limiter = new Limiter(PUSH_CONCURRENCY);
  /** the subscription read of the notification(s) being sent now: notifications started meanwhile share it */
  private rowsInFlight: Promise<PushRow[]> | null = null;

  constructor(
    private readonly deps: AdminApiDeps,
    private readonly roles: RoleService,
    private readonly nowSec: () => number,
  ) {}

  get publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }
  get enabled(): boolean {
    return !!this.vapid;
  }

  async init(): Promise<void> {
    const { config, stores, logger } = this.deps;
    let host = "localhost";
    try {
      host = new URL(config.server.publicUrl).hostname;
    } catch {
      /* ignore */
    }
    const fallbackSubject = `mailto:admin@${host.includes(".") ? host : "example.com"}`;
    try {
      if (config.admin.vapid) {
        this.vapid = { ...config.admin.vapid };
        return;
      }
      // insert-if-absent, then re-read: instances starting together on an empty kv agree on one key pair (a pair
      // overwritten by another instance would invalidate every device subscribed with the first one)
      type Keys = { publicKey: string; privateKey: string };
      const valid = (k: Keys | undefined): k is Keys => !!k?.publicKey && !!k.privateKey;
      const keys = await kvGetOrCreate(stores, "admin", "vapid", () => {
        const gen = webpush.generateVAPIDKeys();
        return { publicKey: gen.publicKey, privateKey: gen.privateKey };
      }, this.nowSec(), valid);
      this.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: fallbackSubject };
    } catch (err) {
      logger.warn("web push disabled: could not initialise VAPID keys", { error: String(err) });
      this.vapid = null;
    }
  }

  /**
   * Stores (or re-assigns, refreshing its age) a subscription, then trims that admin's devices to the cap, oldest
   * first — in one transaction, so concurrent subscribes and re-assigned endpoints can't push past the cap.
   * `sessionId`: the session registering it (null for NIP-98), whose logout drops it again.
   */
  async subscribe(pubkey: string, sub: PushSubscriptionInput, topics: SentPushTopic[], sessionId: string | null = null): Promise<void> {
    if (!isAllowedPushEndpoint(sub.endpoint)) throw new Error("push endpoint is not an allowed Web Push service");
    const json = JSON.stringify(sub);
    const t = JSON.stringify([...new Set(topics)]);
    const now = this.nowSec();
    await this.deps.stores.db.tx(async (db) => {
      const r = await db.run(
        "UPDATE admin_push_subscriptions SET pubkey = ?, subscription = ?, topics = ?, created_at = ?, session_id = ?, failures = 0 WHERE endpoint = ?",
        [pubkey, json, t, now, sessionId, sub.endpoint],
      );
      if (!r.changes) {
        await db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, topics, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)", [
          sub.endpoint,
          pubkey,
          json,
          t,
          now,
          sessionId,
        ]);
      }
      const rows = await db.all<{ endpoint: string }>(
        "SELECT endpoint FROM admin_push_subscriptions WHERE pubkey = ? ORDER BY created_at DESC, endpoint DESC",
        [pubkey],
      );
      const excess = rows.filter((x) => x.endpoint !== sub.endpoint).slice(MAX_SUBSCRIPTIONS_PER_ADMIN - 1);
      for (const old of excess) await db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ?", [old.endpoint]);
    });
  }

  async unsubscribe(pubkey: string, endpoint: string): Promise<boolean> {
    const r = await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ? AND pubkey = ?", [endpoint, pubkey]);
    return r.changes > 0;
  }

  /** Drops the devices a session registered (on logout), so a stolen session can't keep receiving reports. */
  async unsubscribeSession(sessionId: string): Promise<void> {
    await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE session_id = ?", [sessionId]);
  }

  /**
   * Drops the devices of sessions that have ended without a logout (expired, swept, or removed by another instance).
   * Devices registered over NIP-98 (no session) stay.
   */
  async pruneEndedSessions(): Promise<void> {
    this.lastPrune = this.nowSec();
    await this.deps.stores.db.run(
      `DELETE FROM admin_push_subscriptions WHERE session_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM admin_sessions s WHERE s.id = admin_push_subscriptions.session_id AND s.expires_at > ?)`,
      [this.lastPrune],
    );
  }

  /** Drops all of an admin's devices except those registered by `exceptSessionId` (alongside sessions.destroyAllFor). */
  async unsubscribeAllFor(pubkey: string, exceptSessionId?: string): Promise<void> {
    await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE pubkey = ? AND (session_id IS NULL OR session_id <> ?)", [
      pubkey,
      exceptSessionId ?? "",
    ]);
  }

  /**
   * Devices that may receive pushes now. Single-flight: notifications started while a read is running share it, so a
   * burst of them costs one query (and one prune).
   */
  private subscriptions(): Promise<PushRow[]> {
    if (!this.rowsInFlight) {
      this.rowsInFlight = (async () => {
        const now = this.nowSec();
        if (now - this.lastPrune >= PRUNE_INTERVAL_SEC) await this.pruneEndedSessions().catch(() => {});
        // devices of sessions that ended since the last prune are skipped all the same
        const rows = await this.deps.stores.db.all<PushRow>(
          `SELECT p.endpoint, p.pubkey, p.subscription, p.topics, p.failures FROM admin_push_subscriptions p WHERE p.session_id IS NULL OR EXISTS
             (SELECT 1 FROM admin_sessions s WHERE s.id = p.session_id AND s.expires_at > ?)`,
          [now],
        );
        return rows.map((r) => ({ ...r, failures: Number(r.failures ?? 0) }));
      })().finally(() => (this.rowsInFlight = null));
    }
    return this.rowsInFlight;
  }

  private async drop(endpoint: string): Promise<void> {
    await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ?", [endpoint]).catch(() => {});
  }

  /** Counts a refused delivery; MAX_PUSH_FAILURES in a row drop the device. */
  private async recordFailure(endpoint: string): Promise<void> {
    const db = this.deps.stores.db;
    try {
      await db.run("UPDATE admin_push_subscriptions SET failures = failures + 1 WHERE endpoint = ?", [endpoint]);
      const r = await db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ? AND failures >= ?", [endpoint, MAX_PUSH_FAILURES]);
      if (r.changes) this.deps.logger.info("push device dropped after repeated refusals", { endpoint: new URL(endpoint).host });
    } catch {
      /* best effort */
    }
  }

  /**
   * Sends to all subscribers of `topic` whose role grants the topic permission, at most PUSH_CONCURRENCY deliveries at
   * a time (across notifications) and each within `timeoutMs`. Never throws.
   */
  async notify(topic: SentPushTopic, payload: PushPayload): Promise<number> {
    if (!this.vapid) return 0;
    const vapid = this.vapid;
    let rows: PushRow[];
    try {
      rows = await this.subscriptions();
    } catch {
      return 0;
    }
    const body = JSON.stringify(payload);
    const roleCache = new Map<string, Promise<boolean>>();
    const allowed = (pk: string) => {
      let p = roleCache.get(pk);
      if (!p) roleCache.set(pk, (p = this.roles.resolve(pk).then((r) => permissionsFor(r).has(TOPIC_PERMISSION[topic]))));
      return p;
    };
    let sent = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          const topics = JSON.parse(row.topics) as string[];
          if (!topics.includes(topic) || !(await allowed(row.pubkey))) return;
          // rows stored before the endpoint allow-list existed
          if (!isAllowedPushEndpoint(row.endpoint)) return await this.drop(row.endpoint);
          const sub = JSON.parse(row.subscription) as PushSubscriptionInput;
          await this.limiter.run(() => withTimeout(this.sender(sub, body, vapid), this.timeoutMs, "push delivery"));
          sent++;
          if (row.failures > 0) {
            await this.deps.stores.db.run("UPDATE admin_push_subscriptions SET failures = 0 WHERE endpoint = ?", [row.endpoint]).catch(() => {});
          }
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await this.drop(row.endpoint);
          else if (status !== undefined && PERMANENT_FAILURES.has(status)) await this.recordFailure(row.endpoint);
          else this.deps.logger.debug("push send failed", { status, error: String(err) });
        }
      }),
    );
    return sent;
  }
}
