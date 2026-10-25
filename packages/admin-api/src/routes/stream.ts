import { streamSSE } from "hono/streaming";
import type { BusEvents, StreamEvents } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, forbidden, HttpError } from "../errors";
import { requirePermission } from "../middleware/auth";
import { permissionsFor } from "../services/roles";
import { TokenBucket } from "../util/ratelimit";

const MAX_EVENTS_PER_SEC = 50;

/** Buffered-but-unread bytes per SSE stream: live events are dropped above SOFT, the stream is closed above HARD. */
const SSE_SOFT_LIMIT = 1024 * 1024;
const SSE_HARD_LIMIT = 8 * 1024 * 1024;
/** open streams per admin (pubkey): a dashboard per tab or device, not an unbounded number of bus listeners */
export const MAX_STREAMS_PER_ADMIN = 8;

/**
 * JSON of a message every stream sends as is (alerts, reports, snapshots — and event payloads, per variant): serialized
 * once per message however many streams send it, and only by a stream that doesn't shed it.
 */
const serialized = new WeakMap<object, Map<string, string>>();
function jsonOf(source: object, variant: string, data: unknown): string {
  let byVariant = serialized.get(source);
  if (!byVariant) serialized.set(source, (byVariant = new Map()));
  let json = byVariant.get(variant);
  if (json === undefined) byVariant.set(variant, (json = JSON.stringify(data)));
  return json;
}

interface OpenStream {
  pubkey: string;
  /** whether the principal still covers what the stream was opened with (one key per distinct question) */
  check: { key: string; run: () => Promise<boolean> };
  close: () => void;
}

export function registerStreamRoutes(app: AdminApp, ctx: ApiContext) {
  const { metrics, bus } = ctx.deps;
  const snapshotMs = ctx.opts.snapshotIntervalMs ?? 2000;
  const heartbeatMs = ctx.opts.heartbeatMs ?? 15_000;

  // logout, password change (kills other sessions), role removal/downgrade or a ban end the streams within one snapshot
  // interval. One timer for all streams; streams asking the same question (same admin and session, same view) share one
  // check per round, and a round only starts once the previous one is done
  const open = new Set<OpenStream>();
  const perAdmin = new Map<string, number>();
  let authTimer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  const recheck = async () => {
    if (checking) return;
    checking = true;
    try {
      const results = new Map<string, Promise<boolean>>();
      await Promise.all(
        [...open].map(async (s) => {
          let r = results.get(s.check.key);
          if (!r) results.set(s.check.key, (r = s.check.run().catch(() => false)));
          if (!(await r)) s.close();
        }),
      );
    } finally {
      checking = false;
    }
  };
  const track = (s: OpenStream) => {
    open.add(s);
    perAdmin.set(s.pubkey, (perAdmin.get(s.pubkey) ?? 0) + 1);
    if (!authTimer) {
      authTimer = setInterval(() => void recheck(), snapshotMs);
      (authTimer as { unref?: () => void }).unref?.();
    }
  };
  const untrack = (s: OpenStream) => {
    if (!open.delete(s)) return;
    const n = (perAdmin.get(s.pubkey) ?? 1) - 1;
    if (n > 0) perAdmin.set(s.pubkey, n);
    else perAdmin.delete(s.pubkey);
    if (!open.size && authTimer) {
      clearInterval(authTimer);
      authTimer = undefined;
    }
  };

  app.get("/stream", requirePermission("dashboard.view"), (c) => {
    const p = principalOf(c);
    const wantEvents = ["1", "true"].includes(c.req.query("events") ?? "");
    if (wantEvents && !p.permissions.has("content.view")) throw forbidden("missing permission: content.view", "missing_permission");
    const kindsParam = c.req.query("kinds");
    if (kindsParam && !/^\d+(,\d+)*$/.test(kindsParam)) throw badRequest("invalid kinds");
    const kinds = kindsParam ? new Set(kindsParam.split(",").map(Number)) : null;
    if ((perAdmin.get(p.pubkey) ?? 0) >= MAX_STREAMS_PER_ADMIN) {
      throw new HttpError(429, `too many open streams (at most ${MAX_STREAMS_PER_ADMIN} per admin)`, "too_many_streams");
    }
    const showIp = p.role === "owner" || p.role === "admin";
    const canSeeReports = p.permissions.has("reports.view");
    /**
     * The stream outlives the request that authorized it: re-resolve the principal the way the auth middleware does
     * (session still alive, role not revoked, banned or lowered) and report whether it still covers what was opened.
     */
    const stillAuthorized = async () => {
      if (p.via === "session" && !(p.session && (await ctx.sessions.get(p.session.token)))) return false;
      const role = await ctx.roles.resolve(p.pubkey);
      const perms = permissionsFor(role);
      return (
        perms.has("dashboard.view") &&
        (!wantEvents || perms.has("content.view")) &&
        (!canSeeReports || perms.has("reports.view")) &&
        (!showIp || role === "owner" || role === "admin")
      );
    };
    const checkKey = [p.pubkey, p.via === "session" ? (p.session?.id ?? "") : "nip98", wantEvents, canSeeReports, showIp].join("|");
    // counted from here (not once the stream runs), so simultaneous opens can't pass the cap together
    const me: OpenStream = { pubkey: p.pubkey, check: { key: checkKey, run: stillAuthorized }, close: () => untrack(me) };
    track(me);

    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(
      c,
      async (stream) => {
        const cleanups: (() => void)[] = [];
        let closed = false;
        let finish!: () => void;
        const done = new Promise<void>((r) => (finish = r));
        const close = () => {
          if (closed) return;
          closed = true;
          for (const fn of cleanups.splice(0)) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
          finish();
        };
        stream.onAbort(close);
        cleanups.push(() => untrack(me));
        // a recheck between the request and here may already have refused it
        if (!open.has(me)) return close();
        me.close = close;

        // backpressure, like the websocket path: writes settle as the client reads, so `queued` is what a slow or
        // paused reader has left buffered in memory. Above the soft limit live events are shed; above the hard
        // limit the stream is closed (the client reconnects and resyncs from a snapshot).
        let queued = 0;
        /** `json`: the payload, serialized only once it is actually sent */
        const send = (event: keyof StreamEvents, json: () => string) => {
          if (closed) return;
          if (queued > SSE_SOFT_LIMIT && event === "event") return;
          if (queued > SSE_HARD_LIMIT) {
            // abort, not just finish: a graceful close would wait for the stalled reader to drain the buffer
            close();
            stream.abort();
            return;
          }
          const data = json();
          const bytes = data.length + 32;
          queued += bytes;
          stream
            .writeSSE({ event, data })
            .then(() => (queued -= bytes), close);
        };

        let lastSnapshot = 0;
        const sendSnapshot = (s = metrics.snapshot()) => {
          lastSnapshot = ctx.nowMs();
          send("snapshot", () => jsonOf(s, "", s));
        };
        sendSnapshot();
        cleanups.push(
          metrics.onSnapshot((s) => {
            if (ctx.nowMs() - lastSnapshot >= snapshotMs - 100) sendSnapshot(s);
          }),
        );
        // fallback in case the metrics service emits less often than requested
        const snapTimer = setInterval(() => {
          if (ctx.nowMs() - lastSnapshot >= snapshotMs * 1.5) sendSnapshot();
        }, snapshotMs);
        cleanups.push(() => clearInterval(snapTimer));

        const hb = setInterval(() => {
          // skipped while the reader is behind: the backlog already keeps the connection busy
          if (!closed && queued <= SSE_SOFT_LIMIT) stream.write(": ping\n\n").catch(close);
        }, heartbeatMs);
        cleanups.push(() => clearInterval(hb));

        cleanups.push(bus.on("alert", (a) => send("alert", () => jsonOf(a, "", a))));
        if (canSeeReports) cleanups.push(ctx.onReport((r) => send("report", () => jsonOf(r, "", r))));

        if (wantEvents) {
          const bucket = new TokenBucket(MAX_EVENTS_PER_SEC, MAX_EVENTS_PER_SEC, ctx.nowMs);
          // the payload differs between streams only by what the viewer may see (ip) and the geo lookup
          const emit = (source: object, base: StreamEvents["event"], ip: string | undefined) => {
            if (kinds && !kinds.has(base.event.kind)) return;
            if (!bucket.take()) return;
            send("event", () => {
              const geo = ip ? metrics.lookupIp(ip) : undefined;
              const withIp = !!ip && showIp;
              const payload: StreamEvents["event"] = { ...base, ...(geo ? { country: geo.country } : {}), ...(withIp ? { ip } : {}) };
              return jsonOf(source, withIp ? "ip" : "", payload);
            });
          };
          cleanups.push(
            bus.on("event.accepted", (e: BusEvents["event.accepted"]) => emit(e, { event: e.event, status: "accepted" }, e.ip)),
            bus.on("event.rejected", (e: BusEvents["event.rejected"]) => {
              if (e.event) emit(e, { event: e.event, status: "rejected", reason: e.reason }, e.ip);
            }),
          );
        }

        await done;
      },
      async (err) => {
        untrack(me);
        ctx.logger.debug("sse stream error", { error: String(err) });
      },
    );
  });
}
