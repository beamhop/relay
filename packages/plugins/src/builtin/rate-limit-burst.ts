// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { definePlugin, reject } from '../sdk/index.ts';

interface Bucket {
  tokens: number;
  at: number;
}

export const rateLimitBurstPlugin = definePlugin({
  id: 'rate-limit-burst',
  name: 'Stop bursts of posts',
  description:
    'Let people post a short burst quickly, then slow them down to a steady pace. Stops floods without bothering normal users.',
  version: '1.0.0',
  permissions: [],
  configSchema: z.object({
    /** How many posts in a quick burst. */
    burst: z.number().int().positive().max(10_000).default(10),
    /** Steady pace after the burst (posts per minute). */
    perMinute: z.number().positive().max(100_000).default(30),
    /** Count per author, per connection, or per network address (hashed). */
    by: z.enum(['pubkey', 'connection', 'ip']).default('pubkey'),
    /** Only count these kinds (empty = all). */
    kinds: z.array(z.number().int().min(0)).default([]),
    /** Pubkeys (hex) that are never limited. */
    exempt: z.array(z.string()).default([]),
    /** Memory cap: how many senders are tracked at once. */
    maxTracked: z.number().int().positive().max(1_000_000).default(50_000),
  }),
  hooks: (api) => {
    const c = api.config;
    const buckets = new Map<string, Bucket>();
    const exempt = new Set(c.exempt);
    const kinds = new Set(c.kinds);
    const ratePerMs = c.perMinute / 60_000;
    return {
      onEvent(event, ctx) {
        if (exempt.has(event.pubkey)) return;
        if (kinds.size > 0 && !kinds.has(event.kind)) return;
        const key =
          c.by === 'pubkey'
            ? event.pubkey
            : c.by === 'connection'
              ? (ctx.conn?.id ?? event.pubkey)
              : (ctx.conn?.ipHash ?? event.pubkey);
        const now = api.clock.nowMs();
        const prev = buckets.get(key);
        let b: Bucket;
        if (prev) {
          buckets.delete(key); // re-insert to keep LRU order
          b = { tokens: Math.min(c.burst, prev.tokens + (now - prev.at) * ratePerMs), at: now };
        } else {
          b = { tokens: c.burst, at: now };
        }
        buckets.set(key, b);
        if (buckets.size > c.maxTracked) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        if (b.tokens < 1) return reject('rate-limited', 'slow down: too many posts in a row');
        if (!ctx.dryRun) b.tokens -= 1;
      },
    };
  },
});
