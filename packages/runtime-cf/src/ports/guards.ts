// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CPU-time guards for Workers (default 30 s CPU / request, much less on free plans).
 *
 * `GuardedEventStore` wraps any EventStore and runs `query()` in chunks: each filter
 * is paged newest-first with `limit = chunkSize` and an `until` cursor. Between chunks
 * it checks an AbortSignal that combines the caller's signal (client CLOSE) with a
 * per-query time budget. When the budget runs out the partial (still correctly
 * ordered, newest-first) result is returned instead of letting the isolate be killed.
 */
import type {
  EventStore,
  Filter,
  Logger,
  NostrEvent,
  QueryOptions,
  RelayId,
  SaveResult,
  StoreStats,
} from '@beamhop/core';

export interface GuardOptions {
  /** Events fetched per chunk (default 200). */
  chunkSize?: number;
  /** Wall-clock budget per query in ms (default 2000). */
  budgetMs?: number;
  /** Clock in ms (injectable for tests). */
  nowMs?: () => number;
  logger?: Logger;
}

/** Combine abort signals (AbortSignal.any is not available on every runtime). */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function sortDesc(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class GuardedEventStore implements EventStore {
  private readonly chunkSize: number;
  private readonly budgetMs: number;
  private readonly nowMs: () => number;

  constructor(
    readonly inner: EventStore,
    private readonly opts: GuardOptions = {},
  ) {
    this.chunkSize = Math.max(1, opts.chunkSize ?? 200);
    this.budgetMs = opts.budgetMs ?? 2000;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  get capabilities() {
    return this.inner.capabilities;
  }

  init(): Promise<void> {
    return this.inner.init();
  }

  save(relayId: RelayId, event: NostrEvent): Promise<SaveResult> {
    return this.inner.save(relayId, event);
  }

  async query(relayId: RelayId, filters: Filter[], opts?: QueryOptions): Promise<NostrEvent[]> {
    const deadline = this.nowMs() + this.budgetMs;
    const budget = new AbortController();
    const signal = anySignal([opts?.signal, budget.signal]);
    const check = () => {
      if (!signal.aborted && this.nowMs() > deadline) budget.abort(new Error('cpu budget'));
      return signal.aborted;
    };
    const out = new Map<string, NostrEvent>();
    let truncated = false;

    for (const filter of filters) {
      if (check()) {
        truncated = true;
        break;
      }
      let wanted = filter.limit ?? Number.POSITIVE_INFINITY;
      if (opts?.maxLimit !== undefined) wanted = Math.min(wanted, opts.maxLimit);
      if (filter.ids || wanted <= this.chunkSize) {
        // Small or id lookups: single call, no paging needed.
        try {
          const page = await this.inner.query(relayId, [filter], { ...opts, signal });
          for (const e of page) out.set(e.id, e);
        } catch (err) {
          if (!signal.aborted) throw err;
          truncated = true;
        }
        continue;
      }
      let got = 0;
      let until = filter.until;
      const seen = new Set<string>();
      while (got < wanted) {
        if (check()) {
          truncated = true;
          break;
        }
        const pageLimit = Math.min(this.chunkSize, wanted - got);
        // `until` is inclusive: over-fetch by the number of already-seen ids at the boundary.
        const page = await this.inner
          .query(relayId, [{ ...filter, until, limit: pageLimit + seen.size }], {
            signal,
          })
          .catch((err) => {
            if (signal.aborted) return null;
            throw err;
          });
        if (page === null) {
          truncated = true;
          break;
        }
        let fresh = 0;
        for (const e of page) {
          if (seen.has(e.id)) continue;
          if (got >= wanted) break;
          out.set(e.id, e);
          got++;
          fresh++;
        }
        if (page.length < pageLimit + seen.size || fresh === 0) break;
        const last = page[page.length - 1] as NostrEvent;
        if (last.created_at !== until) seen.clear();
        until = last.created_at;
        for (const e of page) if (e.created_at === until) seen.add(e.id);
      }
    }
    if (truncated) {
      this.opts.logger?.log('warn', 'Query stopped early to stay within CPU limits', {
        relayId,
        results: out.size,
      });
    }
    return [...out.values()].sort(sortDesc);
  }

  count(relayId: RelayId, filters: Filter[]): Promise<number> {
    return this.inner.count(relayId, filters);
  }

  getById(relayId: RelayId, id: string): Promise<NostrEvent | null> {
    return this.inner.getById(relayId, id);
  }

  applyDeletion(relayId: RelayId, deletion: NostrEvent): Promise<string[]> {
    return this.inner.applyDeletion(relayId, deletion);
  }

  vanish(relayId: RelayId, pubkey: string, until: number): Promise<number> {
    return this.inner.vanish(relayId, pubkey, until);
  }

  deleteByIds(relayId: RelayId, ids: string[], opts?: { tombstone?: boolean }): Promise<number> {
    return this.inner.deleteByIds(relayId, ids, opts);
  }

  deleteMatching(relayId: RelayId, filter: Filter): Promise<number> {
    return this.inner.deleteMatching(relayId, filter);
  }

  deleteExpired(now: number): Promise<number> {
    return this.inner.deleteExpired(now);
  }

  stats(relayId?: RelayId): Promise<StoreStats> {
    return this.inner.stats(relayId);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
