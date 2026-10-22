import webpush from "web-push";
import type { AdminApiDeps, Permission, PushTopic } from "@beamhop/sdk";
import { permissionsFor, type RoleService } from "./roles";

export const PUSH_TOPICS: readonly PushTopic[] = ["reports", "alerts", "users"];
const TOPIC_PERMISSION: Record<PushTopic, Permission> = {
  reports: "reports.view",
  alerts: "dashboard.view",
  users: "users.view",
};

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
  await webpush.sendNotification(sub, payload, {
    TTL: 3600,
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
};

export class PushService {
  private vapid: Vapid | null = null;
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

  async subscribe(pubkey: string, sub: PushSubscriptionInput, topics: PushTopic[]): Promise<void> {
    const db = this.deps.stores.db;
    const json = JSON.stringify(sub);
    const t = JSON.stringify([...new Set(topics)]);
    const r = await db.run("UPDATE admin_push_subscriptions SET pubkey = ?, subscription = ?, topics = ? WHERE endpoint = ?", [pubkey, json, t, sub.endpoint]);
    if (!r.changes) {
      await db.run("INSERT INTO admin_push_subscriptions (endpoint, pubkey, subscription, topics, created_at) VALUES (?, ?, ?, ?, ?)", [
        sub.endpoint,
        pubkey,
        json,
        t,
        this.nowSec(),
      ]);
    }
  }

  async unsubscribe(pubkey: string, endpoint: string): Promise<boolean> {
    const r = await this.deps.stores.db.run("DELETE FROM admin_push_subscriptions WHERE endpoint = ? AND pubkey = ?", [endpoint, pubkey]);
    return r.changes > 0;
  }

  /** Sends to all subscribers of `topic` whose role grants the topic permission. Never throws. */
  async notify(topic: PushTopic, payload: PushPayload): Promise<number> {
    if (!this.vapid) return 0;
    const vapid = this.vapid;
    let rows: { endpoint: string; pubkey: string; subscription: string; topics: string }[];
    try {
      rows = await this.deps.stores.db.all("SELECT endpoint, pubkey, subscription, topics FROM admin_push_subscriptions");
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
