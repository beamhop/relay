// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web of trust (§5.1): breadth-first walk over kind 3 follow lists starting
 * at the owner + seeds. Follows of the roots (depth 1) are always trusted;
 * deeper candidates need at least `minFollowers` distinct trusted followers.
 */
import { type EventStore, type NostrEvent, type RelayId, verifyEvent } from '@beamhop/core';
import { HEX64 } from './util.ts';

/** Optional upstream source of follow lists (e.g. a WebSocket client to public relays). */
export type FollowFetcher = (authors: string[]) => Promise<NostrEvent[]>;

export interface WotMember {
  depth: number;
  /** Distinct trusted followers when admitted (0 for roots). */
  followers: number;
}

export interface WotGraph {
  relayId: RelayId;
  computedAt: number;
  roots: string[];
  depth: number;
  minFollowers: number;
  members: Record<string, WotMember>;
  /** True when the walk stopped at maxMembers. */
  truncated: boolean;
}

export interface WotParams {
  roots: string[];
  depth: number;
  minFollowers: number;
  maxMembers: number;
}

/** Newest valid kind 3 per author → followed pubkeys (deduplicated, hex only). */
export function followListsFromEvents(events: NostrEvent[]): Map<string, string[]> {
  const newest = new Map<string, NostrEvent>();
  for (const e of events) {
    if (e.kind !== 3) continue;
    const cur = newest.get(e.pubkey);
    if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id < cur.id))
      newest.set(e.pubkey, e);
  }
  const out = new Map<string, string[]>();
  for (const [pk, e] of newest) {
    const set = new Set<string>();
    for (const t of e.tags)
      if (t[0] === 'p' && t[1] && HEX64.test(t[1]) && t[1] !== pk) set.add(t[1]);
    out.set(pk, [...set]);
  }
  return out;
}

/** Follow-list loader: local store first, merged with (verified) upstream results. */
export function followLoader(
  events: EventStore,
  relayId: RelayId,
  upstream?: FollowFetcher,
  batch = 250,
): (authors: string[]) => Promise<Map<string, string[]>> {
  return async (authors) => {
    const all: NostrEvent[] = [];
    for (let i = 0; i < authors.length; i += batch) {
      const chunk = authors.slice(i, i + batch);
      all.push(...(await events.query(relayId, [{ kinds: [3], authors: chunk }])));
      if (upstream) {
        const wanted = new Set(chunk);
        try {
          const ext = await upstream(chunk);
          for (const e of ext)
            if (e.kind === 3 && wanted.has(e.pubkey) && verifyEvent(e)) all.push(e);
        } catch {
          // Upstream is optional; fall back to local data.
        }
      }
    }
    return followListsFromEvents(all);
  };
}

/** Pure BFS over follow lists. */
export async function computeWot(
  relayId: RelayId,
  params: WotParams,
  loadFollows: (authors: string[]) => Promise<Map<string, string[]>>,
  now: number,
): Promise<WotGraph> {
  const roots = [...new Set(params.roots.filter((r) => HEX64.test(r)))];
  const members: Record<string, WotMember> = {};
  for (const r of roots) members[r] = { depth: 0, followers: 0 };
  let count = roots.length;
  let truncated = false;
  /** Candidate → distinct trusted followers seen so far. */
  const pending = new Map<string, Set<string>>();
  let frontier = roots;
  for (let d = 1; d <= params.depth && frontier.length > 0 && !truncated; d++) {
    const follows = await loadFollows(frontier);
    for (const author of frontier) {
      for (const p of follows.get(author) ?? []) {
        if (members[p]) continue;
        let s = pending.get(p);
        if (!s) {
          s = new Set();
          pending.set(p, s);
        }
        s.add(author);
      }
    }
    const need = d === 1 ? 1 : Math.max(1, params.minFollowers);
    const next: string[] = [];
    // Deterministic order: most-followed first, then pubkey.
    const ranked = [...pending.entries()].sort(
      (a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1),
    );
    for (const [p, s] of ranked) {
      if (s.size < need) continue;
      if (count >= params.maxMembers) {
        truncated = true;
        break;
      }
      members[p] = { depth: d, followers: s.size };
      count++;
      pending.delete(p);
      next.push(p);
    }
    frontier = next;
  }
  return {
    relayId,
    computedAt: now,
    roots,
    depth: params.depth,
    minFollowers: params.minFollowers,
    members,
    truncated,
  };
}
