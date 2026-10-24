import { lookup } from "node:dns/promises";
import webpush from "web-push";
import type { AdminApiDeps, Permission, PushTopic } from "@beamhop/sdk";
import { isPrivateIp } from "../util/ip";
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

const defaultSender: PushSender = async (sub, payload, vapid) => {
  // defence in depth against split-horizon DNS for the allow-listed hosts (web-push itself never follows redirects)
  const host = new URL(sub.endpoint).hostname;
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error(`push endpoint ${host} resolves to a private address`);
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
      let keys = await stores.kv.get<{ publicKey: string; privateKey: string }>("admin", "vapid");
      if (!keys?.publicKey || !keys.privateKey) {
        const gen = webpush.generateVAPIDKeys();
        keys = { publicKey: gen.publicKey, privateKey: gen.privateKey };
        await stores.kv.set("admin", "vapid", keys);
      }
      this.vapid = { ...keys, subject: fallbackSubject };
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
        "UPDATE admin_push_subscriptions SET pubkey = ?, subscription = ?, topics = ?, created_at = ?, session_id = ? WHERE endpoint = ?",
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

  /** Sends to all subscribers of `topic` whose role grants the topic permission. Never throws. */
  async notify(topic: SentPushTopic, payload: PushPayload): Promise<number> {
    if (!this.vapid) return 0;
    const vapid = this.vapid;
    let rows: { endpoint: string; pubkey: string; subscription: string; topics: string }[];
    try {
      const now = this.nowSec();
      if (now - this.lastPrune >= PRUNE_INTERVAL_SEC) await this.pruneEndedSessions().catch(() => {});
      // devices of sessions that ended since the last prune are skipped all the same
      rows = await this.deps.stores.db.all(
        `SELECT p.endpoint, p.pubkey, p.subscription, p.topics FROM admin_push_subscriptions p WHERE p.session_id IS NULL OR EXISTS
           (SELECT 1 FROM admin_sessions s WHERE s.id = p.session_id AND s.expires_at > ?)`,
        [now],
      );
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
          if (!isAllowedPushEndpoint(row.endpoint)) {
            await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ?", [row.endpoint]).catch(() => {});
            return;
          }
          await this.sender(JSON.parse(row.subscription), body, vapid);
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ?", [row.endpoint]).catch(() => {});
          } else {
            this.deps.logger.debug("push send failed", { status, error: String(err) });
          }
        }
      }),
    );
    return sent;
  }
}
