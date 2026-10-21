// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BeamhopConfig, RelayConfig } from './config.ts';

/** Resolve the virtual relay for a request by Host header (+ optional path prefix). */
export function resolveRelay(
  config: BeamhopConfig,
  url: URL,
  hostHeader?: string | null,
): RelayConfig | undefined {
  const host = (hostHeader ?? url.host).toLowerCase().replace(/:\d+$/, '');
  const candidates = config.relays.filter((r) =>
    r.hosts.some((h) => h.toLowerCase() === host || h === '*'),
  );
  // Longest matching path prefix wins; exact host beats wildcard.
  let best: RelayConfig | undefined;
  let bestScore = -1;
  for (const r of candidates) {
    const prefix = r.pathPrefix ?? '';
    if (prefix && !pathHasPrefix(url.pathname, prefix)) continue;
    const score = prefix.length * 2 + (r.hosts.includes('*') ? 0 : 1);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best ?? (config.relays.length === 1 ? config.relays[0] : undefined);
}

/**
 * Segment-aware prefix match: `/team` matches `/team` and `/team/x` but not
 * `/teams`. A prefix ending in `/` matches anything under it.
 */
export function pathHasPrefix(pathname: string, prefix: string): boolean {
  if (!prefix || prefix === '/') return true;
  if (prefix.endsWith('/')) return pathname.startsWith(prefix) || pathname === prefix.slice(0, -1);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
