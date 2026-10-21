// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NostrEvent } from '@beamhop/core';
import { z } from 'zod';
import { assertPublicUrl } from '../net/ssrf.ts';
import { type PluginApi, definePlugin, reject } from '../sdk/index.ts';

const ConfigSchema = z.object({
  /** Kinds anyone may publish without a verified address (0 = profile, so people can add one). */
  exemptKinds: z.array(z.number().int().min(0)).default([0]),
  /** Only addresses on these domains count (empty = any domain). */
  allowedDomains: z.array(z.string().min(1)).default([]),
  /** Remember a successful check for this long (seconds). */
  cacheSeconds: z.number().int().positive().default(3600),
  /** Remember a failed check for this long (seconds). */
  negativeCacheSeconds: z.number().int().positive().default(300),
  /** Give up on a slow server after this long (ms). */
  lookupTimeoutMs: z.number().int().positive().max(30_000).default(3000),
  /** Memory cap for the cache. */
  maxCached: z.number().int().positive().default(20_000),
});
type Config = z.infer<typeof ConfigSchema>;

interface CacheEntry {
  ok: boolean;
  until: number;
}

/** Split a NIP-05 identifier into name + domain (bare domain → `_`). */
export function parseNip05(id: string): { name: string; domain: string } | null {
  const s = id.trim().toLowerCase();
  const at = s.lastIndexOf('@');
  const name = at >= 0 ? s.slice(0, at) : '_';
  const domain = at >= 0 ? s.slice(at + 1) : s;
  if (!/^[a-z0-9._-]+$/.test(name)) return null;
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(domain) || !domain.includes('.')) return null;
  return { name, domain };
}

function nip05Of(profile: NostrEvent | undefined): string | null {
  if (!profile) return null;
  try {
    const v = (JSON.parse(profile.content) as { nip05?: unknown }).nip05;
    return typeof v === 'string' && v.length > 0 && v.length < 320 ? v : null;
  } catch {
    return null;
  }
}

/** Fetch `/.well-known/nostr.json` and check that `name` maps to `pubkey`. */
export async function verifyNip05(
  api: Pick<PluginApi<unknown>, 'fetch'>,
  pubkey: string,
  nip05: string,
  timeoutMs: number,
): Promise<boolean> {
  const p = parseNip05(nip05);
  if (!p) return false;
  const url = await assertPublicUrl(
    `https://${p.domain}/.well-known/nostr.json?name=${encodeURIComponent(p.name)}`,
  );
  const res = await api.fetch(url.toString(), {
    // NIP-05: clients must ignore redirects.
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) return false;
  const body = (await res.json()) as { names?: Record<string, unknown> };
  const found = body?.names?.[p.name];
  return typeof found === 'string' && found.toLowerCase() === pubkey;
}

export const nip05RequiredPlugin = definePlugin({
  id: 'nip05-required',
  name: 'Require a verified address to post',
  description:
    'Only people with a verified Nostr address (like name@example.com) on their profile can post. Results are remembered so checks stay fast.',
  version: '1.0.0',
  permissions: ['read-events', 'network'],
  configSchema: ConfigSchema,
  hooks: (api) => {
    const c: Config = api.config;
    const cache = new Map<string, CacheEntry>();
    const inflight = new Map<string, Promise<boolean>>();
    const exempt = new Set(c.exemptKinds);
    const domains = new Set(c.allowedDomains.map((d) => d.toLowerCase()));

    const check = async (pubkey: string, nip05: string): Promise<boolean> => {
      const key = `${pubkey}:${nip05.toLowerCase()}`;
      const now = api.clock.now();
      const hit = cache.get(key);
      if (hit && hit.until > now) return hit.ok;
      let p = inflight.get(key);
      if (!p) {
        p = verifyNip05(api, pubkey, nip05, c.lookupTimeoutMs)
          .catch((err) => {
            api.log('debug', 'NIP-05 lookup failed', { err: String(err) });
            return false;
          })
          .then((ok) => {
            cache.delete(key);
            cache.set(key, {
              ok,
              until: api.clock.now() + (ok ? c.cacheSeconds : c.negativeCacheSeconds),
            });
            if (cache.size > c.maxCached) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            return ok;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    };

    return {
      async onEvent(event, ctx) {
        if (exempt.has(event.kind)) return;
        const [profile] = await api.events.query(ctx.relayId, [
          { kinds: [0], authors: [event.pubkey], limit: 1 },
        ]);
        const nip05 = nip05Of(profile);
        if (!nip05) {
          return reject(
            'restricted',
            'add a verified Nostr address (NIP-05) to your profile to post here',
          );
        }
        const parsed = parseNip05(nip05);
        if (!parsed || (domains.size > 0 && !domains.has(parsed.domain))) {
          return reject('restricted', 'your Nostr address is not from an accepted domain');
        }
        if (!(await check(event.pubkey, nip05))) {
          return reject('restricted', 'your Nostr address (NIP-05) could not be verified');
        }
      },
    };
  },
});
