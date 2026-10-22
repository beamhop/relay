import { streamSSE } from "hono/streaming";
import type { BusEvents, StreamEvents } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, forbidden } from "../errors";
import { requirePermission } from "../middleware/auth";
import { TokenBucket } from "../util/ratelimit";

const MAX_EVENTS_PER_SEC = 50;

export function registerStreamRoutes(app: AdminApp, ctx: ApiContext) {
  const { metrics, bus } = ctx.deps;
  const snapshotMs = ctx.opts.snapshotIntervalMs ?? 2000;
  const heartbeatMs = ctx.opts.heartbeatMs ?? 15_000;

  app.get("/stream", requirePermission("dashboard.view"), (c) => {
    const p = principalOf(c);
    const wantEvents = ["1", "true"].includes(c.req.query("events") ?? "");
    if (wantEvents && !p.permissions.has("content.view")) throw forbidden("missing permission: content.view", "missing_permission");
    const kindsParam = c.req.query("kinds");
    if (kindsParam && !/^\d+(,\d+)*$/.test(kindsParam)) throw badRequest("invalid kinds");
    const kinds = kindsParam ? new Set(kindsParam.split(",").map(Number)) : null;
    const showIp = p.role === "owner" || p.role === "admin";
    const canSeeReports = p.permissions.has("reports.view");

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

        const send = <K extends keyof StreamEvents>(event: K, data: StreamEvents[K]) => {
          if (closed) return;
          stream.writeSSE({ event, data: JSON.stringify(data) }).catch(close);
        };

        let lastSnapshot = 0;
        const sendSnapshot = (s = metrics.snapshot()) => {
          lastSnapshot = ctx.nowMs();
          send("snapshot", s);
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
          if (!closed) stream.write(": ping\n\n").catch(close);
        }, heartbeatMs);
        cleanups.push(() => clearInterval(hb));

        cleanups.push(bus.on("alert", (a) => send("alert", a)));
        if (canSeeReports) cleanups.push(ctx.onReport((r) => send("report", r)));

        if (wantEvents) {
          const bucket = new TokenBucket(MAX_EVENTS_PER_SEC, MAX_EVENTS_PER_SEC, ctx.nowMs);
          const emit = (payload: StreamEvents["event"], ip: string | undefined) => {
            if (kinds && !kinds.has(payload.event.kind)) return;
            if (!bucket.take()) return;
            if (ip) {
              const geo = metrics.lookupIp(ip);
              if (geo) payload.country = geo.country;
              if (showIp) payload.ip = ip;
            }
            send("event", payload);
          };
          cleanups.push(
            bus.on("event.accepted", (e: BusEvents["event.accepted"]) => emit({ event: e.event, status: "accepted" }, e.ip)),
            bus.on("event.rejected", (e: BusEvents["event.rejected"]) => {
              if (e.event) emit({ event: e.event, status: "rejected", reason: e.reason }, e.ip);
            }),
          );
        }

        await done;
      },
      async (err) => {
        ctx.logger.debug("sse stream error", { error: String(err) });
      },
    );
  });
}
