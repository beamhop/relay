/**
 * NIP-40: Expiration Timestamp.
 *
 * An event may carry an `["expiration", "<unix-seconds>"]` tag. After that time
 * the event is considered expired:
 *   - On arrival, an already-expired event is rejected (OK false).
 *   - A stored event that later expires is hidden from REQ replies and live
 *     broadcast (via a visibility filter) without being mutated.
 *   - On a configurable interval, expired events are swept from the store.
 *
 * The expiration boundary is exclusive of "now == expiration": per NIP-40 an
 * event expires *after* the timestamp, so it remains valid while now <= exp.
 */
import type { NostrEvent } from "../types.ts";
import type { NostrPlugin, PluginContext } from "../plugin.ts";

/** The expiration timestamp (Unix seconds) of an event, or undefined if none/invalid. */
export function expirationOf(event: NostrEvent): number | undefined {
  for (const tag of event.tags) {
    if (tag[0] !== "expiration" || tag[1] === undefined) continue;
    const ts = Number(tag[1]);
    if (Number.isFinite(ts)) return ts;
  }
  return undefined;
}

/** Whether an event is expired relative to `now` (Unix seconds). */
export function isExpired(event: NostrEvent, now: number): boolean {
  const exp = expirationOf(event);
  return exp !== undefined && now > exp;
}

export interface Nip40Options {
  /**
   * How often (ms) to sweep expired events from the store. 0 disables the
   * background sweep (events are still hidden from clients). Default 0 so the
   * relay stays timer-free unless asked.
   */
  sweepIntervalMs?: number;
}

export function nip40(opts: Nip40Options = {}): NostrPlugin {
  const sweepIntervalMs = opts.sweepIntervalMs ?? 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const now = (ctx: PluginContext): number =>
    ctx.config.now ? ctx.config.now() : Math.floor(Date.now() / 1000);

  return {
    name: "nip40",
    supportedNips: [40],

    eventValidators: [
      (event, ctx) =>
        isExpired(event, now(ctx))
          ? { ok: false, reason: "invalid: event has already expired" }
          : { ok: true },
    ],

    visibilityFilters: [(event, ctx) => !isExpired(event, now(ctx))],

    onInstall(ctx) {
      if (sweepIntervalMs <= 0) return;
      timer = setInterval(() => sweepExpired(ctx, now(ctx)), sweepIntervalMs);
      // Don't keep the process alive solely for the sweep.
      timer.unref?.();
    },
  };
}

/** Remove every expired event from the store. Returns the number swept. */
export function sweepExpired(ctx: PluginContext, now: number): number {
  let swept = 0;
  for (const event of ctx.store.query([{}])) {
    if (isExpired(event, now) && ctx.store.delete(event.id)) swept++;
  }
  return swept;
}
