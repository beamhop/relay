// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retention (§10): per-kind rules, tier `retentionDays` and the goals-derived
 * `defaultRetentionDays`, applied by a chunked scheduled sweep that resumes
 * from a stored cursor. Also: blob ownership expiry from tier retention, and
 * storage caps (prune oldest low-value kinds — automatic only when the admin
 * turned `autoPrune` on; otherwise a suggestion card, §6.8).
 *
 * Precedence for one event (see docs/backups.md "Retention"):
 *   1. a rule naming the event's kind (several → the longest wins)
 *   2. the author's tier `retentionDays`
 *   3. a rule without kinds (relay-wide)
 *   4. goals-derived `defaultRetentionDays` (absent → keep forever)
 * Steps 2-4 only touch regular kinds: profiles, follow lists and other
 * replaceable/addressable events, and deletion requests (kinds 5, 62), are
 * kept unless a rule names their kind explicitly.
 *
 * Every deletion first asks the legal-hold registry (`lifecycle.holds`).
 */
import {
  type BlobOwnership,
  type Filter,
  type NostrEvent,
  type RelayConfig,
  type RelayId,
  kindClass,
} from '@beamhop/core';
import type { LifecycleRuntime } from './runtime.ts';
import { COL, type StorageCap } from './settings.ts';

const DAY = 86_400;
const PROTECTED_KINDS = new Set([5, 62]);

export interface RetentionPlan {
  relayId: RelayId;
  /** Kind-specific rules, grouped by days. */
  kindRules: Array<{ kinds: number[]; days: number }>;
  /** Relay-wide rule (no kinds). */
  genericDays?: number;
  /** Tier id → retentionDays. */
  tierDays: Record<string, number>;
  /** Goals-derived default (without tier). */
  goalDays?: number;
  /** Smallest age that the general sweep can delete (undefined → no general sweep). */
  minGeneralDays?: number;
}

export interface RetentionState {
  lastRunAt?: number;
  lastCompleteAt?: number;
  /** Sweep key → `until` cursor to resume from. */
  cursors: Record<string, number>;
  lastDeleted?: number;
}

export interface SweepResult {
  scanned: number;
  deleted: number;
  bytes: number;
  complete: boolean;
  cursor?: number;
}

export interface RunResult {
  relayId: RelayId;
  deleted: number;
  scanned: number;
  complete: boolean;
  pruned?: number;
}

export function isProtectedKind(kind: number): boolean {
  return PROTECTED_KINDS.has(kind) || kindClass(kind) !== 'regular';
}

/** Approximate stored size, matching storage-sql `stats()` (content + tags + 290). */
export function eventBytes(e: NostrEvent): number {
  return e.content.length + JSON.stringify(e.tags).length + 290;
}

export class RetentionEngine {
  private pending = new Set<Promise<unknown>>();

  constructor(private readonly rt: LifecycleRuntime) {}

  private get ports() {
    return this.rt.ports;
  }

  /** Wait for async bus handlers (blob expiry) to finish — tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  track<T>(p: Promise<T>): void {
    const q = p.catch((err) => this.rt.log('warn', 'lifecycle task failed', { err: String(err) }));
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
  }

  plan(relay: RelayConfig): RetentionPlan {
    const byKind = new Map<number, number>();
    let genericDays: number | undefined;
    for (const rule of relay.retention) {
      if (rule.kinds?.length) {
        for (const k of rule.kinds) byKind.set(k, Math.max(byKind.get(k) ?? 0, rule.days));
      } else {
        genericDays = Math.max(genericDays ?? 0, rule.days);
      }
    }
    const groups = new Map<number, number[]>();
    for (const [k, d] of byKind) groups.set(d, [...(groups.get(d) ?? []), k]);
    const tierDays: Record<string, number> = {};
    for (const t of relay.tiers) if (t.retentionDays) tierDays[t.id] = t.retentionDays;
    const goalDays = this.rt.kernel.limits(relay.id).defaultRetentionDays;
    const candidates = [...Object.values(tierDays)];
    // Authors without a tier-specific value fall back to the generic rule, then goals.
    const fallback = genericDays ?? goalDays;
    if (fallback !== undefined) candidates.push(fallback);
    const minGeneralDays = candidates.length ? Math.min(...candidates) : undefined;
    return {
      relayId: relay.id,
      kindRules: [...groups].map(([days, kinds]) => ({ days, kinds: kinds.sort((a, b) => a - b) })),
      ...(genericDays !== undefined ? { genericDays } : {}),
      tierDays,
      ...(goalDays !== undefined ? { goalDays } : {}),
      ...(minGeneralDays !== undefined ? { minGeneralDays } : {}),
    };
  }

  hasRetention(relay: RelayConfig): boolean {
    const p = this.plan(relay);
    return p.kindRules.length > 0 || p.minGeneralDays !== undefined;
  }

  async state(relayId: RelayId): Promise<RetentionState> {
    return (await this.ports.docs.get<RetentionState>(COL.retention, relayId)) ?? { cursors: {} };
  }

  private async allowed(relayId: RelayId, e: NostrEvent): Promise<boolean> {
    if (!this.rt.holds.active()) return true;
    return !(await this.rt.holds.isHeld(relayId, {
      pubkey: e.pubkey,
      eventId: e.id,
      createdAt: e.created_at,
      kind: e.kind,
    }));
  }

  /**
   * Delete events matching `base` with `created_at <= until`, newest first,
   * in chunks, skipping held ones and those `decide` keeps.
   */
  async sweep(
    relayId: RelayId,
    base: Filter,
    until: number,
    budget: number,
    decide: (e: NostrEvent) => boolean | Promise<boolean> = () => true,
  ): Promise<SweepResult> {
    const chunk = this.rt.settings().retention.chunkSize;
    const out: SweepResult = { scanned: 0, deleted: 0, bytes: 0, complete: false };
    let cursor = until;
    for (;;) {
      if (out.scanned >= budget) return { ...out, cursor };
      const limit = Math.min(chunk, budget - out.scanned);
      const page = await this.ports.events.query(relayId, [{ ...base, until: cursor, limit }]);
      if (!page.length) return { ...out, complete: true };
      out.scanned += page.length;
      const del: NostrEvent[] = [];
      for (const e of page) if ((await decide(e)) && (await this.allowed(relayId, e))) del.push(e);
      let n = 0;
      if (del.length) {
        const ids = del.map((e) => e.id);
        n = await this.ports.events.deleteByIds(relayId, ids);
        out.deleted += n;
        for (const e of del) out.bytes += eventBytes(e);
        this.rt.kernel.bus.emit('event.deleted', { relayId, ids, cause: 'retention', count: n });
      }
      if (page.length < limit) return { ...out, complete: true };
      if (n < page.length) {
        const minC = Math.min(...page.map((e) => e.created_at));
        cursor = minC < cursor ? minC : minC - 1;
        if (base.since !== undefined && cursor < base.since) return { ...out, complete: true };
      }
    }
  }

  /** One retention pass for a relay (resumes where the last one stopped). */
  async runRelay(relay: RelayConfig): Promise<RunResult> {
    const now = this.ports.clock.now();
    const plan = this.plan(relay);
    const st = await this.state(relay.id);
    let budget = this.rt.settings().retention.maxEventsPerRun;
    let deleted = 0;
    let scanned = 0;
    let complete = true;

    const sweepKey = async (
      key: string,
      base: Filter,
      cutoff: number,
      decide?: (e: NostrEvent) => boolean | Promise<boolean>,
    ) => {
      const from = Math.min(st.cursors[key] ?? cutoff, cutoff);
      const r = await this.sweep(relay.id, base, from, budget, decide);
      budget -= r.scanned;
      deleted += r.deleted;
      scanned += r.scanned;
      if (r.complete) delete st.cursors[key];
      else {
        st.cursors[key] = r.cursor ?? from;
        complete = false;
      }
      return r.complete;
    };

    for (const g of plan.kindRules) {
      if (!(await sweepKey(`k:${g.kinds.join(',')}`, { kinds: g.kinds }, now - g.days * DAY)))
        break;
    }

    if (complete && plan.minGeneralDays !== undefined) {
      const ruled = new Set(plan.kindRules.flatMap((g) => g.kinds));
      const tiers = new Map<string, string>();
      const fallback = plan.genericDays ?? plan.goalDays;
      await sweepKey('general', {}, now - plan.minGeneralDays * DAY, async (e) => {
        if (ruled.has(e.kind) || isProtectedKind(e.kind)) return false;
        let tier = tiers.get(e.pubkey);
        if (tier === undefined) {
          tier = await this.rt.tierOf(relay, e.pubkey);
          tiers.set(e.pubkey, tier);
        }
        const days = plan.tierDays[tier] ?? fallback;
        return days !== undefined && e.created_at <= now - days * DAY;
      });
    }

    for (const k of Object.keys(st.cursors))
      if (k !== 'general' && !plan.kindRules.some((g) => `k:${g.kinds.join(',')}` === k))
        delete st.cursors[k];

    st.lastRunAt = now;
    st.lastDeleted = deleted;
    if (complete) st.lastCompleteAt = now;
    await this.ports.docs.put(COL.retention, relay.id, st);
    if (deleted)
      this.rt.log('info', 'retention removed old posts', { relayId: relay.id, deleted, scanned });
    return { relayId: relay.id, deleted, scanned, complete };
  }

  /** Scheduled tick: retention, held-blob postponement, automatic pruning if enabled. */
  async tick(): Promise<RunResult[]> {
    if (this.rt.restoring) return [];
    const out: RunResult[] = [];
    const s = this.rt.settings();
    for (const relay of this.rt.relays()) {
      const r: RunResult = s.retention.enabled
        ? await this.runRelay(relay)
        : { relayId: relay.id, deleted: 0, scanned: 0, complete: true };
      const cap = this.capFor(relay.id);
      if (cap?.autoPrune) {
        const status = await this.capStatus(relay.id);
        if (status?.over) r.pruned = (await this.prune(relay.id)).deleted;
      }
      out.push(r);
    }
    await this.postponeHeldBlobs();
    return out;
  }

  // ── blobs ──

  /** Tier retention → blob ownership `expiresAt` (only ever shortens an existing expiry). */
  async onBlobUploaded(p: { relayId: RelayId; sha256: string; pubkey: string }): Promise<void> {
    const relay = this.rt.kernel.relay(p.relayId);
    if (!relay) return;
    const tier = await this.rt.tierOf(relay, p.pubkey);
    const days = relay.tiers.find((t) => t.id === tier)?.retentionDays;
    if (!days) return;
    const own = (await this.ports.blobIndex.owners(p.relayId, p.sha256)).find(
      (o) => o.pubkey === p.pubkey,
    );
    if (!own) return;
    if (
      this.rt.holds.active() &&
      (await this.rt.holds.isHeld(p.relayId, { pubkey: p.pubkey, sha256: p.sha256 }))
    )
      return;
    const expiresAt = own.uploadedAt + days * DAY;
    if (own.expiresAt !== undefined && own.expiresAt <= expiresAt) return;
    await this.ports.blobIndex.addOwner({ ...own, expiresAt });
  }

  /** Push back the expiry of held blob ownerships so blob GC never removes them. */
  async postponeHeldBlobs(): Promise<number> {
    if (!this.rt.holds.active()) return 0;
    const horizon = 2 * this.rt.settings().retention.intervalMinutes * 60 + 3600;
    const now = this.ports.clock.now();
    const soon: BlobOwnership[] = await this.ports.blobIndex.expired(now + horizon, 1000);
    let n = 0;
    for (const o of soon) {
      if (await this.rt.holds.isHeld(o.relayId, { pubkey: o.pubkey, sha256: o.sha256 })) {
        await this.ports.blobIndex.addOwner({ ...o, expiresAt: now + horizon * 2 });
        n++;
      }
    }
    return n;
  }

  // ── storage caps ──

  capFor(relayId: RelayId): StorageCap | undefined {
    const caps = this.rt.settings().storageCaps;
    return caps[relayId] ?? caps['*'];
  }

  async capStatus(
    relayId: RelayId,
  ): Promise<{ over: boolean; bytes: number; maxBytes: number; targetBytes: number } | null> {
    const cap = this.capFor(relayId);
    if (!cap) return null;
    const stats = await this.ports.events.stats(relayId);
    return {
      over: stats.bytes > cap.maxBytes,
      bytes: stats.bytes,
      maxBytes: cap.maxBytes,
      targetBytes: Math.floor((cap.maxBytes * cap.targetPercent) / 100),
    };
  }

  /** Estimate what pruning would remove (preview). */
  async pruneEstimate(relayId: RelayId): Promise<{ candidates: number; needBytes: number }> {
    const cap = this.capFor(relayId);
    const status = await this.capStatus(relayId);
    if (!cap || !status) return { candidates: 0, needBytes: 0 };
    return {
      candidates: await this.ports.events.count(relayId, [{ kinds: cap.lowValueKinds }]),
      needBytes: Math.max(0, status.bytes - status.targetBytes),
    };
  }

  /** Delete the oldest low-value events (day windows, oldest first) until under the target. */
  async prune(relayId: RelayId): Promise<{ deleted: number; freedBytes: number; under: boolean }> {
    const cap = this.capFor(relayId);
    if (!cap) return { deleted: 0, freedBytes: 0, under: true };
    const stats = await this.ports.events.stats(relayId);
    const target = Math.floor((cap.maxBytes * cap.targetPercent) / 100);
    let need = stats.bytes - target;
    if (need <= 0 || stats.oldest === undefined) return { deleted: 0, freedBytes: 0, under: true };
    const now = this.ports.clock.now();
    let budget = this.rt.settings().retention.maxEventsPerRun;
    let deleted = 0;
    let freed = 0;
    for (let since = stats.oldest; since <= now && need > 0 && budget > 0; since += DAY) {
      const r = await this.sweep(
        relayId,
        { kinds: cap.lowValueKinds, since },
        since + DAY - 1,
        budget,
      );
      budget -= r.scanned;
      deleted += r.deleted;
      freed += r.bytes;
      need -= r.bytes;
    }
    return { deleted, freedBytes: freed, under: need <= 0 };
  }
}
