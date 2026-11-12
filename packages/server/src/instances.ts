import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type DatabaseInstanceInfo, isDbSwitchingError, type KvStore, type Logger } from "@beamhop/sdk";

/** kv namespace and key prefix of the heartbeats: `server` / `instances/<id>` → {@link Heartbeat} */
export const INSTANCES_NS = "server";
export const INSTANCE_KEY_PREFIX = "instances/";
/** heartbeats older than this are deleted by any instance (crashed instances never delete their own) */
const FORGET_AFTER_SEC = 24 * 3600;

interface Heartbeat {
  /** unix seconds */
  seenAt: number;
  host?: string;
}

export interface InstanceHeartbeatOptions {
  kv: KvStore;
  logger: Logger;
  /** how often this instance writes its heartbeat (default 30 s) */
  intervalMs?: number;
  /** heartbeats older than this don't count as a running instance (default 90 s) */
  staleMs?: number;
  /** reported host name (default: the machine's) */
  host?: string;
  /** clock in unix ms (tests) */
  now?: () => number;
  /** this instance's id (default: random) */
  id?: string;
}

export interface InstanceHeartbeat {
  /** this instance's id */
  readonly id: string;
  /** instances with a fresh heartbeat (this one marked `self`), most recently seen first */
  instances(): Promise<DatabaseInstanceInfo[]>;
  /** writes this instance's heartbeat now (refusals during a database switch are swallowed) */
  beat(): Promise<void>;
  /** stops beating and deletes this instance's heartbeat */
  stop(): Promise<void>;
}

/**
 * Single-instance detection for runtime database switching: every instance writes a heartbeat to kv
 * (`server` / `instances/<id>`) every `intervalMs`; a switch is refused while another instance has a fresh one. The kv
 * store goes through the switchable database wrapper, so heartbeats follow a switch by themselves.
 */
export function startInstanceHeartbeat(opts: InstanceHeartbeatOptions): InstanceHeartbeat {
  const { kv } = opts;
  const log = opts.logger;
  const id = opts.id ?? randomUUID();
  const host = opts.host ?? safeHostname();
  const intervalMs = opts.intervalMs ?? 30_000;
  const staleMs = opts.staleMs ?? 90_000;
  const now = opts.now ?? Date.now;
  const key = INSTANCE_KEY_PREFIX + id;
  let stopped = false;
  let beating: Promise<void> | undefined;

  const write = async () => {
    try {
      await kv.set(INSTANCES_NS, key, { seenAt: Math.floor(now() / 1000), host } satisfies Heartbeat);
    } catch (err) {
      // writes paused by a database switch: the next beat goes to whichever database is current then
      if (isDbSwitchingError(err)) log.debug("instance heartbeat deferred: database switch in progress");
      else log.warn("instance heartbeat failed", { error: String(err) });
    }
  };
  const beat = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // one write at a time (a slow database must not pile them up)
    beating ??= write().finally(() => (beating = undefined));
    return beating;
  };

  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    id,
    beat,
    async instances() {
      const all = await kv.list<Heartbeat>(INSTANCES_NS);
      const nowSec = Math.floor(now() / 1000);
      const out: DatabaseInstanceInfo[] = [];
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(INSTANCE_KEY_PREFIX) || !v || typeof v !== "object" || typeof v.seenAt !== "number") continue;
        const otherId = k.slice(INSTANCE_KEY_PREFIX.length);
        const self = otherId === id;
        if (!self && nowSec - v.seenAt > FORGET_AFTER_SEC) {
          // long gone (crashed without deleting it): tidy up, best effort
          kv.delete(INSTANCES_NS, k).catch(() => {});
          continue;
        }
        if (!self && (nowSec - v.seenAt) * 1000 > staleMs) continue;
        out.push({ id: otherId, seenAt: v.seenAt, ...(typeof v.host === "string" ? { host: v.host } : {}), self });
      }
      return out.sort((a, b) => b.seenAt - a.seenAt || a.id.localeCompare(b.id));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await beating?.catch(() => {});
      try {
        await kv.delete(INSTANCES_NS, key);
      } catch (err) {
        // left behind: it goes stale on its own
        if (!isDbSwitchingError(err)) log.warn("removing instance heartbeat failed", { error: String(err) });
      }
    },
  };
}

function safeHostname(): string | undefined {
  try {
    return hostname();
  } catch {
    return undefined;
  }
}
