// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Append-only, hash-chained audit log fed by `admin.action` bus events.
 * Each entry stores the hash of the previous entry; the sequence key is
 * written with compare-and-set so concurrent writers never fork the chain.
 */
import type { AppEvents, Kernel, RelayId } from '@beamhop/core';
import { COL } from './settings.ts';
import { canonicalJson, redact, seqKey, sha256Hex } from './util.ts';

export const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  seq: number;
  at: number;
  relayId: RelayId | null;
  actionId: string;
  principalId: string;
  input: unknown;
  summary: string;
  ok: boolean;
  prevHash: string;
  hash: string;
}

export type AuditRecord = Omit<AuditEntry, 'seq' | 'prevHash' | 'hash' | 'at'>;

export async function hashEntry(e: Omit<AuditEntry, 'hash'>): Promise<string> {
  return sha256Hex(canonicalJson(e));
}

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kernel: Kernel) {}

  /** Subscribe to the bus. Returns the unsubscribe function. */
  attach(): () => void {
    return this.kernel.bus.on('admin.action', (e: AppEvents['admin.action']) => {
      void this.enqueue(e);
    });
  }

  enqueue(rec: AuditRecord): Promise<AuditEntry> {
    const p = this.queue.then(() => this.append(rec));
    this.queue = p.catch((err) => {
      this.kernel.ports.logger.log('error', 'audit append failed', { error: String(err) });
    });
    return p;
  }

  /** Wait for all queued entries to be written. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async last(): Promise<AuditEntry | null> {
    const page = await this.kernel.ports.docs.list<AuditEntry>(COL.audit, {
      reverse: true,
      limit: 1,
    });
    return page.items[0]?.value ?? null;
  }

  private async append(rec: AuditRecord): Promise<AuditEntry> {
    const docs = this.kernel.ports.docs;
    for (let attempt = 0; attempt < 50; attempt++) {
      const last = await this.last();
      const base: Omit<AuditEntry, 'hash'> = {
        seq: (last?.seq ?? 0) + 1,
        at: this.kernel.ports.clock.now(),
        relayId: rec.relayId,
        actionId: rec.actionId,
        principalId: rec.principalId,
        input: redact(rec.input) ?? null,
        summary: rec.summary,
        ok: rec.ok,
        prevHash: last?.hash ?? GENESIS,
      };
      const entry: AuditEntry = { ...base, hash: await hashEntry(base) };
      if (await docs.cas(COL.audit, seqKey(entry.seq), null, entry)) return entry;
    }
    throw new Error('audit append: too much contention');
  }

  async list(opts: { limit?: number; cursor?: string; relayId?: RelayId | null } = {}): Promise<{
    items: AuditEntry[];
    cursor?: string;
  }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const items: AuditEntry[] = [];
    let cursor = opts.cursor;
    // Relay filter: scan pages until we have enough matches.
    for (let i = 0; i < 20 && items.length < limit; i++) {
      const page = await this.kernel.ports.docs.list<AuditEntry>(COL.audit, {
        reverse: true,
        limit,
        cursor,
      });
      for (const it of page.items) {
        if (opts.relayId && it.value.relayId !== opts.relayId) continue;
        if (items.length < limit) items.push(it.value);
      }
      cursor = page.cursor;
      if (!cursor) break;
    }
    const lastItem = items[items.length - 1];
    const more = items.length >= limit ? lastItem!.seq > 1 : !!cursor;
    return { items, cursor: more && lastItem ? seqKey(lastItem.seq) : undefined };
  }

  /** Recompute the whole chain. */
  async verify(): Promise<{ ok: boolean; count: number; brokenAt?: number; reason?: string }> {
    let prev = GENESIS;
    let expected = 1;
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await this.kernel.ports.docs.list<AuditEntry>(COL.audit, { cursor, limit: 500 });
      for (const { value } of page.items) {
        const { hash, ...rest } = value;
        if (value.seq !== expected)
          return { ok: false, count, brokenAt: expected, reason: 'missing entry' };
        if (value.prevHash !== prev)
          return { ok: false, count, brokenAt: value.seq, reason: 'chain link mismatch' };
        if ((await hashEntry(rest)) !== hash)
          return { ok: false, count, brokenAt: value.seq, reason: 'entry was modified' };
        prev = hash;
        expected++;
        count++;
      }
      cursor = page.cursor;
    } while (cursor);
    return { ok: true, count };
  }
}
