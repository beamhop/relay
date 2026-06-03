/**
 * NIP-22: Event `created_at` Limits.
 *
 * A relay may reject events whose `created_at` is too far in the past or future
 * relative to the relay's clock. Bounds are expressed as a number of seconds:
 *   - `lower`: reject if created_at < now - lower (too old)
 *   - `upper`: reject if created_at > now + upper (too far in the future)
 *
 * Off by default: with neither bound set, every timestamp is accepted. Uses
 * `config.now` (Unix seconds) as the clock so tests are deterministic.
 */
import type { NostrPlugin, PluginContext } from "../plugin.ts";

export interface Nip22Options {
  /** Max seconds an event may be *older* than now. Unset = no lower bound. */
  lower?: number;
  /** Max seconds an event may be in the *future*. Unset = no upper bound. */
  upper?: number;
}

export function nip22(opts: Nip22Options = {}): NostrPlugin {
  const now = (ctx: PluginContext): number =>
    ctx.config.now ? ctx.config.now() : Math.floor(Date.now() / 1000);

  return {
    name: "nip22",
    supportedNips: [22],

    eventValidators: [
      (event, ctx) => {
        const t = now(ctx);
        if (opts.lower !== undefined && event.created_at < t - opts.lower) {
          return { ok: false, reason: "invalid: created_at is too far in the past" };
        }
        if (opts.upper !== undefined && event.created_at > t + opts.upper) {
          return { ok: false, reason: "invalid: created_at is too far in the future" };
        }
        return { ok: true };
      },
    ],
  };
}
