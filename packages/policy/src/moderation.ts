// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation queue (§5.3) and recycle bin (§6.11).
 *
 * Queue items come from held events (`event.held`), NIP-56 reports
 * (`report.received`) and flagged blobs (`blob.quarantined`). Similar items
 * share a `batchKey` so the PWA and attention cards can collapse them.
 *
 * Removals are soft: the event/blob goes to `policy.recycle` for
 * `recycleDays` (default 30) and can be restored until purged.
 */
import { type EventBus, type NostrEvent, type Ports, type RelayId, kindClass } from '@beamhop/core';
import { COLLECTIONS, type PolicyState, type RecycleEntry } from './state.ts';
import { HEX64, listAll, rkey } from './util.ts';

export type QueueStatus = 'pending' | 'kept' | 'removed';

export interface ReportEntry {
  reportId: string;
  reporter: string;
  /** NIP-56 report type (nudity, malware, profanity, illegal, spam, impersonation, other). */
  type: string;
  comment?: string;
  at: number;
}

export interface QueueItem {
  id: string;
  relayId: RelayId;
  type: 'event' | 'report' | 'blob';
  status: QueueStatus;
  createdAt: number;
  updatedAt: number;
  /** Items with the same key are batched into one card. */
  batchKey: string;
  /** Plain-language reason. */
  reason: string;
  technical?: string;
  /** Hook / source that produced the item. */
  source?: string;
  eventId?: string;
  pubkey?: string;
  sha256?: string;
  event?: NostrEvent;
  reports?: ReportEntry[];
  decidedBy?: string;
  decidedAt?: number;
}

export const REPORT_TYPE_LABELS: Record<string, string> = {
  nudity: 'nudity',
  malware: 'malware',
  profanity: 'offensive language',
  illegal: 'possibly illegal content',
  spam: 'spam',
  impersonation: 'impersonation',
  other: 'other problems',
};

const KNOWN_TYPES = new Set(Object.keys(REPORT_TYPE_LABELS));

/** Parse a NIP-56 report into its subject and type. */
export function parseReport(report: NostrEvent):
  | {
      eventId?: string;
      pubkey?: string;
      sha256?: string;
      type: string;
    }
  | undefined {
  if (report.kind !== 1984) return undefined;
  let eventId: string | undefined;
  let pubkey: string | undefined;
  let sha256: string | undefined;
  let type: string | undefined;
  for (const t of report.tags) {
    const [name, value, rtype] = t;
    if (!value) continue;
    if (name === 'e' && HEX64.test(value) && !eventId) {
      eventId = value;
      if (rtype) type = rtype;
    } else if (name === 'p' && HEX64.test(value) && !pubkey) {
      pubkey = value;
      if (rtype && !type) type = rtype;
    } else if (name === 'x' && HEX64.test(value) && !sha256) {
      sha256 = value;
      if (rtype) type = rtype;
    }
  }
  if (!eventId && !pubkey && !sha256) return undefined;
  const norm = type && KNOWN_TYPES.has(type) ? type : 'other';
  return { eventId, pubkey, sha256, type: norm };
}

/** Structural view of lifecycle's legal-hold registry (`kernel.use('lifecycle.holds')`). */
export interface LegalHoldsLike {
  isHeld(
    relayId: RelayId,
    subject: {
      pubkey?: string;
      eventId?: string;
      createdAt?: number;
      kind?: number;
      sha256?: string;
    },
  ): Promise<boolean>;
  active?(): boolean;
}

export class ModerationQueue {
  constructor(
    private readonly ports: Ports,
    private readonly bus: EventBus,
    private readonly state: PolicyState,
    private readonly recycleDays: () => number,
    /** Legal holds (§12.7): held recycle entries are never purged. */
    private readonly holds: () => LegalHoldsLike | undefined = () => undefined,
  ) {}

  /** Is a recycle entry frozen by a legal hold? (fails safe: errors count as held) */
  private async isHeld(relayId: RelayId, entry: RecycleEntry): Promise<boolean> {
    const holds = this.holds();
    if (!holds || (typeof holds.active === 'function' && !holds.active())) return false;
    try {
      if (entry.type === 'event') {
        const e = entry.event;
        return await holds.isHeld(relayId, {
          eventId: entry.id,
          ...(e ? { pubkey: e.pubkey, createdAt: e.created_at, kind: e.kind } : {}),
        });
      }
      if (await holds.isHeld(relayId, { sha256: entry.id })) return true;
      for (const pubkey of entry.owners ?? [])
        if (await holds.isHeld(relayId, { sha256: entry.id, pubkey })) return true;
      return false;
    } catch {
      return true;
    }
  }

  async get(relayId: RelayId, id: string): Promise<QueueItem | null> {
    return this.ports.docs.get<QueueItem>(COLLECTIONS.queue, rkey(relayId, id));
  }

  async put(item: QueueItem): Promise<void> {
    await this.ports.docs.put(COLLECTIONS.queue, rkey(item.relayId, item.id), item);
  }

  /** Items oldest first. */
  async list(
    relayId: RelayId,
    opts: { status?: QueueStatus; batchKey?: string } = {},
  ): Promise<QueueItem[]> {
    const all = await listAll<QueueItem>(this.ports.docs, COLLECTIONS.queue, `${relayId}:`);
    return all
      .map((x) => x.value)
      .filter(
        (i) =>
          (!opts.status || i.status === opts.status) &&
          (!opts.batchKey || i.batchKey === opts.batchKey),
      )
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  async addHeld(
    relayId: RelayId,
    event: NostrEvent,
    by?: string,
    reason?: string,
  ): Promise<QueueItem> {
    const now = this.ports.clock.now();
    const id = `held-${event.id}`;
    const existing = await this.get(relayId, id);
    if (existing) return existing;
    const item: QueueItem = {
      id,
      relayId,
      type: 'event',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      batchKey: `held:${by ?? 'policy'}`,
      reason: reason ?? 'Held for review by an automatic filter',
      technical: `event ${event.id} kind ${event.kind} held by ${by ?? 'unknown'}`,
      source: by,
      eventId: event.id,
      pubkey: event.pubkey,
      event,
    };
    await this.put(item);
    return item;
  }

  async addReport(relayId: RelayId, report: NostrEvent): Promise<QueueItem | undefined> {
    const parsed = parseReport(report);
    if (!parsed) return undefined;
    const now = this.ports.clock.now();
    const subject = parsed.eventId
      ? `e-${parsed.eventId}`
      : parsed.sha256
        ? `x-${parsed.sha256}`
        : `p-${parsed.pubkey}`;
    const id = `report-${subject}`;
    const entry: ReportEntry = {
      reportId: report.id,
      reporter: report.pubkey,
      type: parsed.type,
      at: report.created_at,
      ...(report.content ? { comment: report.content.slice(0, 500) } : {}),
    };
    const existing = await this.get(relayId, id);
    if (existing) {
      const reports = existing.reports ?? [];
      if (reports.some((r) => r.reporter === entry.reporter || r.reportId === entry.reportId)) {
        return existing;
      }
      const next = { ...existing, reports: [...reports, entry], updatedAt: now };
      await this.put(next);
      return next;
    }
    let event: NostrEvent | undefined;
    if (parsed.eventId) {
      event = (await this.ports.events.getById(relayId, parsed.eventId)) ?? undefined;
    }
    const label = REPORT_TYPE_LABELS[parsed.type] ?? 'other problems';
    const what = parsed.eventId ? 'A post' : parsed.sha256 ? 'A file' : 'An account';
    const item: QueueItem = {
      id,
      relayId,
      type: 'report',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      batchKey: `report:${parsed.type}`,
      reason: `${what} was reported for ${label}`,
      technical: `NIP-56 kind 1984 report (${parsed.type}) on ${subject}`,
      source: 'nip56',
      eventId: parsed.eventId,
      pubkey: parsed.pubkey ?? event?.pubkey,
      sha256: parsed.sha256,
      reports: [entry],
      ...(event ? { event } : {}),
    };
    await this.put(item);
    return item;
  }

  async addBlob(relayId: RelayId, sha256: string, reason: string): Promise<QueueItem> {
    const now = this.ports.clock.now();
    const id = `blob-${sha256}`;
    const existing = await this.get(relayId, id);
    if (existing) return existing;
    const owners = await this.ports.blobIndex.owners(relayId, sha256);
    const item: QueueItem = {
      id,
      relayId,
      type: 'blob',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      batchKey: 'blob:flagged',
      reason: `A file was flagged: ${reason}`,
      technical: `blob ${sha256} quarantined (${reason})`,
      source: 'blob.quarantined',
      sha256,
      pubkey: owners[0]?.pubkey,
    };
    await this.put(item);
    return item;
  }

  async setStatus(
    relayId: RelayId,
    id: string,
    status: QueueStatus,
    by: string,
  ): Promise<QueueItem | null> {
    const item = await this.get(relayId, id);
    if (!item) return null;
    const now = this.ports.clock.now();
    const next: QueueItem =
      status === 'pending'
        ? { ...item, status, updatedAt: now, decidedBy: undefined, decidedAt: undefined }
        : { ...item, status, updatedAt: now, decidedBy: by, decidedAt: now };
    await this.put(next);
    return next;
  }

  // ── recycle bin ──

  /** Soft-remove an event: copy to the recycle bin, then delete from the store. */
  async removeEvent(
    relayId: RelayId,
    event: NostrEvent,
    by: string,
    reason?: string,
  ): Promise<RecycleEntry> {
    const now = this.ports.clock.now();
    const entry: RecycleEntry = {
      id: event.id,
      type: 'event',
      event,
      removedAt: now,
      purgeAt: now + this.recycleDays() * 86400,
      by,
      ...(reason ? { reason } : {}),
    };
    await this.state.putRecycled(relayId, entry);
    await this.ports.events.deleteByIds(relayId, [event.id]);
    this.bus.emit('event.deleted', { relayId, ids: [event.id], cause: 'admin' });
    return entry;
  }

  /** Soft-remove a blob: it stops being served; owners are kept until purge. */
  async removeBlob(
    relayId: RelayId,
    sha256: string,
    by: string,
    reason?: string,
  ): Promise<RecycleEntry> {
    const now = this.ports.clock.now();
    const owners = (await this.ports.blobIndex.owners(relayId, sha256)).map((o) => o.pubkey);
    const entry: RecycleEntry = {
      id: sha256,
      type: 'blob',
      owners,
      removedAt: now,
      purgeAt: now + this.recycleDays() * 86400,
      by,
      ...(reason ? { reason } : {}),
    };
    await this.state.putRecycled(relayId, entry);
    return entry;
  }

  /** Restore from the recycle bin. Events deleted by their author (NIP-09/62) stay deleted. */
  async restore(
    relayId: RelayId,
    id: string,
  ): Promise<{ ok: true; entry: RecycleEntry } | { ok: false; reason: string }> {
    const entry = await this.state.getRecycled(relayId, id);
    if (!entry) return { ok: false, reason: 'not in the recycle bin' };
    if (entry.type === 'event' && entry.event) {
      const res = await this.ports.events.save(relayId, entry.event);
      await this.state.dropRecycled(relayId, id);
      if (res.status === 'deleted') return { ok: false, reason: 'deleted by its author' };
      return { ok: true, entry };
    }
    await this.state.dropRecycled(relayId, id);
    return { ok: true, entry };
  }

  /** Permanently purge recycle entries past their purge date. */
  async purge(now: number): Promise<number> {
    const all = await listAll<RecycleEntry>(this.ports.docs, COLLECTIONS.recycle, '');
    let n = 0;
    for (const { key, value } of all) {
      if (value.purgeAt > now) continue;
      const relayId = key.slice(0, key.length - value.id.length - 1);
      // Legal hold freezes deletion: keep the entry (re-checked on every pass).
      if (await this.isHeld(relayId, value)) continue;
      if (value.type === 'event') {
        // Tombstone regular events so a re-broadcast of the exact event is refused after purge.
        // (Stores only tombstone ids they hold, so re-insert first; never touches replaceables.)
        if (value.event && kindClass(value.event.kind) === 'regular') {
          const res = await this.ports.events.save(relayId, value.event);
          if (res.status === 'saved' || res.status === 'duplicate') {
            await this.ports.events.deleteByIds(relayId, [value.id], { tombstone: true });
          }
        }
      } else {
        for (const pk of value.owners ?? []) {
          if (await this.ports.blobIndex.removeOwner(relayId, value.id, pk)) {
            this.bus.emit('blob.deleted', {
              relayId,
              sha256: value.id,
              pubkey: pk,
              cause: 'moderation',
            });
          }
        }
      }
      await this.state.dropRecycled(relayId, value.id);
      n++;
    }
    return n;
  }
}
