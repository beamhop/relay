// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SIEM exporter. Two durable sources, both hash-chained:
 *  1. the admin audit log (`admin.audit`, written by admin-api), read by sequence;
 *  2. the compliance event log (`compliance.siem-outbox`): auth, config, deletion,
 *     approval, signing and escrow records, chained here (seq/prevHash/hash).
 * Each sink keeps its own cursor in the DocStore, so restarts resume exactly where
 * they stopped. Batching, exponential backoff and a bounded outbox (backpressure).
 */
import type { AppEvents } from '@beamhop/core';
import { COL, type SinkConfig } from '../config.ts';
import type { Rt, SiemInput, SiemStream } from '../runtime.ts';
import { canonicalJson, errMsg, padKey, redact, sha256Hex } from '../util.ts';
import type { SiemRecord } from './format.ts';
import { type FetchLike, type Sink, type SyslogTransportFactory, createSink } from './sinks.ts';

export const AUDIT_COLLECTION = 'admin.audit';
export const GENESIS = '0'.repeat(64);

interface AuditEntryLike {
  seq: number;
  at: number;
  relayId: string | null;
  actionId: string;
  principalId: string;
  input: unknown;
  summary: string;
  ok: boolean;
  prevHash: string;
  hash: string;
}

export interface OutboxEntry {
  seq: number;
  at: number;
  stream: SiemStream;
  type: string;
  relayId: string | null;
  principalId?: string;
  summary: string;
  data?: unknown;
  prevHash: string;
  hash: string;
}

interface Head {
  seq: number;
  hash: string;
}

export interface SinkState {
  auditSeq: number;
  outboxSeq: number;
  failures: number;
  nextAttemptAt: number;
  sent: number;
  dropped: number;
  lastError?: string;
  lastErrorAt?: number;
  lastSuccessAt?: number;
}

const EMPTY_STATE: SinkState = {
  auditSeq: 0,
  outboxSeq: 0,
  failures: 0,
  nextAttemptAt: 0,
  sent: 0,
  dropped: 0,
};

export async function hashOutboxEntry(e: Omit<OutboxEntry, 'hash'>): Promise<string> {
  return sha256Hex(canonicalJson(e));
}

/** Verify a contiguous run of compliance event-log entries (tamper evidence). */
export async function verifyOutboxChain(
  entries: OutboxEntry[],
): Promise<{ ok: boolean; brokenAt?: number }> {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const { hash, ...rest } = e;
    if ((await hashOutboxEntry(rest)) !== hash) return { ok: false, brokenAt: e.seq };
    const prev = entries[i - 1];
    if (prev && (e.prevHash !== prev.hash || e.seq !== prev.seq + 1))
      return { ok: false, brokenAt: e.seq };
  }
  return { ok: true };
}

export interface ExporterOptions {
  fetch?: FetchLike;
  syslogTransport?: SyslogTransportFactory;
}

export class SiemExporter {
  private queue: Promise<unknown> = Promise.resolve();
  private sinks = new Map<string, { cfgKey: string; sink: Sink }>();
  private running = false;
  private unsub: Array<() => void> = [];

  constructor(
    private readonly rt: Rt,
    private readonly opts: ExporterOptions = {},
  ) {}

  private cfg() {
    return this.rt.settings().siem;
  }

  /** Subscribe to bus events that become SIEM records. */
  attach(): void {
    const bus = this.rt.kernel.bus;
    const on = <K extends keyof AppEvents>(name: K, fn: (p: AppEvents[K]) => void) =>
      this.unsub.push(bus.on(name, fn));
    on('auth.success', (p) => {
      if (!this.cfg().authEvents) return;
      this.record({
        stream: 'auth',
        type: 'auth.success',
        relayId: p.relayId,
        principalId: p.pubkey,
        summary: 'Someone signed in to the relay',
        data: { pubkey: p.pubkey, connId: p.connId },
      });
    });
    on('config.changed', (p) =>
      this.record({
        stream: 'config',
        type: 'config.changed',
        principalId: p.principalId,
        summary: p.summary,
        data: { revision: p.revision },
      }),
    );
    on('event.deleted', (p) => {
      if (!this.cfg().deletionEvents) return;
      this.record({
        stream: 'deletion',
        type: `event.deleted.${p.cause}`,
        relayId: p.relayId,
        summary: `${p.count ?? p.ids.length} post(s) deleted (${p.cause})`,
        data: { ids: p.ids.slice(0, 100), count: p.count ?? p.ids.length, cause: p.cause },
      });
    });
    on('blob.deleted', (p) => {
      if (!this.cfg().deletionEvents) return;
      this.record({
        stream: 'deletion',
        type: 'blob.deleted',
        relayId: p.relayId,
        summary: `A file was deleted (${p.cause})`,
        data: { sha256: p.sha256, pubkey: p.pubkey ?? null, cause: p.cause },
      });
    });
  }

  detach(): void {
    for (const u of this.unsub.splice(0)) u();
  }

  /** Append a record to the compliance event log (no-op without sinks). */
  record(input: SiemInput): Promise<OutboxEntry | null> {
    if (this.cfg().sinks.length === 0) return Promise.resolve(null);
    const p = this.queue.then(() => this.append(input));
    this.queue = p.catch((err) =>
      this.rt.log('error', 'SIEM event log append failed', { err: errMsg(err) }),
    );
    return p;
  }

  /** Wait for queued records to be written. */
  async settle(): Promise<void> {
    await this.queue;
  }

  private async append(input: SiemInput): Promise<OutboxEntry> {
    const docs = this.rt.ports.docs;
    for (let attempt = 0; attempt < 50; attempt++) {
      const head = await docs.get<Head>(COL.outboxHead, 'head');
      const base: Omit<OutboxEntry, 'hash'> = {
        seq: (head?.seq ?? 0) + 1,
        at: this.rt.now(),
        stream: input.stream,
        type: input.type,
        relayId: input.relayId ?? null,
        summary: input.summary,
        prevHash: head?.hash ?? GENESIS,
      };
      if (input.principalId) base.principalId = input.principalId;
      if (input.data !== undefined) base.data = redact(input.data);
      const entry: OutboxEntry = { ...base, hash: await hashOutboxEntry(base) };
      if (
        await docs.cas<Head>(COL.outboxHead, 'head', head, { seq: entry.seq, hash: entry.hash })
      ) {
        await docs.put(COL.outbox, padKey(entry.seq), entry);
        return entry;
      }
    }
    throw new Error('SIEM event log: too much contention');
  }

  private sinkFor(cfg: SinkConfig): Sink {
    const key = canonicalJson(cfg);
    const cur = this.sinks.get(cfg.id);
    if (cur && cur.cfgKey === key) return cur.sink;
    void cur?.sink.close?.().catch(() => {});
    const sink = createSink(cfg, {
      fetch: this.opts.fetch ?? ((i, init) => fetch(i, init)),
      runtime: this.rt.kernel.runtime,
      nodeId: this.rt.kernel.config().node.id,
      now: () => this.rt.now(),
      ...(this.opts.syslogTransport ? { syslogTransport: this.opts.syslogTransport } : {}),
    });
    this.sinks.set(cfg.id, { cfgKey: key, sink });
    return sink;
  }

  async state(sinkId: string): Promise<SinkState> {
    return {
      ...EMPTY_STATE,
      ...((await this.rt.ports.docs.get<SinkState>(COL.sinkState, sinkId)) ?? {}),
    };
  }

  private async saveState(sinkId: string, s: SinkState): Promise<void> {
    await this.rt.ports.docs.put(COL.sinkState, sinkId, s);
  }

  private nodeId(): string {
    return this.rt.kernel.config().node.id;
  }

  private fromAudit(e: AuditEntryLike): SiemRecord {
    return {
      id: `audit:${e.seq}`,
      stream: 'audit',
      type: e.actionId,
      at: e.at,
      node: this.nodeId(),
      relayId: e.relayId,
      principalId: e.principalId,
      summary: e.summary,
      ok: e.ok,
      data: { input: e.input },
      chain: { log: 'admin.audit', seq: e.seq, prevHash: e.prevHash, hash: e.hash },
    };
  }

  private fromOutbox(e: OutboxEntry): SiemRecord {
    const r: SiemRecord = {
      id: `evt:${e.seq}`,
      stream: e.stream,
      type: e.type,
      at: e.at,
      node: this.nodeId(),
      relayId: e.relayId,
      summary: e.summary,
      chain: { log: 'compliance.events', seq: e.seq, prevHash: e.prevHash, hash: e.hash },
    };
    if (e.principalId) r.principalId = e.principalId;
    if (e.data !== undefined) r.data = e.data;
    return r;
  }

  /** Next batch for a sink without moving its cursor. */
  private async nextBatch(
    cfg: SinkConfig,
    st: SinkState,
    max: number,
  ): Promise<{ records: SiemRecord[]; auditSeq: number; outboxSeq: number; dropped: number }> {
    const docs = this.rt.ports.docs;
    const wants = (s: SiemStream) => !cfg.streams?.length || cfg.streams.includes(s);
    const records: SiemRecord[] = [];
    let auditSeq = st.auditSeq;
    let outboxSeq = st.outboxSeq;
    let dropped = 0;

    // Backpressure: records older than the outbox floor were dropped; skip and count them.
    const head = await docs.get<Head>(COL.outboxHead, 'head');
    const floor = Math.max(0, (head?.seq ?? 0) - this.cfg().maxOutbox);
    if (outboxSeq < floor) {
      dropped = floor - outboxSeq;
      outboxSeq = floor;
    }

    const audit = await docs.list<AuditEntryLike>(AUDIT_COLLECTION, {
      cursor: auditSeq > 0 ? String(auditSeq).padStart(12, '0') : undefined,
      limit: max,
    });
    for (const { value } of audit.items) {
      auditSeq = value.seq;
      if (wants('audit')) records.push(this.fromAudit(value));
    }
    const room = max - records.length;
    if (room > 0) {
      const out = await docs.list<OutboxEntry>(COL.outbox, {
        cursor: outboxSeq > 0 ? padKey(outboxSeq) : undefined,
        limit: room,
      });
      for (const { value } of out.items) {
        outboxSeq = value.seq;
        if (wants(value.stream)) records.push(this.fromOutbox(value));
      }
    }
    return { records, auditSeq, outboxSeq, dropped };
  }

  private backoff(failures: number): number {
    return Math.min(15 * 60, 5 * 2 ** Math.min(failures - 1, 10));
  }

  /** Push pending records to every enabled sink. Safe to call concurrently (one runs). */
  async tick(): Promise<Record<string, { sent: number; error?: string }>> {
    const result: Record<string, { sent: number; error?: string }> = {};
    if (this.running) return result;
    this.running = true;
    try {
      await this.settle();
      const cfg = this.cfg();
      for (const sinkCfg of cfg.sinks) {
        if (!sinkCfg.enabled) continue;
        result[sinkCfg.id] = await this.drainSink(sinkCfg);
      }
      await this.gc();
    } finally {
      this.running = false;
    }
    return result;
  }

  private async drainSink(sinkCfg: SinkConfig): Promise<{ sent: number; error?: string }> {
    const cfg = this.cfg();
    let st = await this.state(sinkCfg.id);
    const now = this.rt.now();
    if (st.nextAttemptAt > now) return { sent: 0, error: st.lastError ?? 'waiting to retry' };
    let sent = 0;
    for (let b = 0; b < cfg.maxBatchesPerTick; b++) {
      const batch = await this.nextBatch(sinkCfg, st, cfg.batchSize);
      if (batch.auditSeq === st.auditSeq && batch.outboxSeq === st.outboxSeq && !batch.dropped)
        break;
      try {
        if (batch.records.length) await this.sinkFor(sinkCfg).send(batch.records);
      } catch (err) {
        const failures = st.failures + 1;
        st = {
          ...st,
          failures,
          nextAttemptAt: this.rt.now() + this.backoff(failures),
          lastError: errMsg(err),
          lastErrorAt: this.rt.now(),
        };
        await this.saveState(sinkCfg.id, st);
        this.rt.log('warn', 'SIEM export failed; will retry', {
          sink: sinkCfg.id,
          failures,
          err: errMsg(err),
        });
        return { sent, error: errMsg(err) };
      }
      sent += batch.records.length;
      st = {
        ...st,
        auditSeq: batch.auditSeq,
        outboxSeq: batch.outboxSeq,
        failures: 0,
        nextAttemptAt: 0,
        sent: st.sent + batch.records.length,
        dropped: st.dropped + batch.dropped,
        lastSuccessAt: this.rt.now(),
      };
      // Persist after every batch: a crash re-sends at most one batch (at-least-once).
      await this.saveState(sinkCfg.id, st);
    }
    return { sent };
  }

  /** Delete outbox entries every enabled sink has exported, and entries past the cap. */
  private async gc(): Promise<void> {
    const docs = this.rt.ports.docs;
    const sinks = this.cfg().sinks.filter((s) => s.enabled);
    const head = await docs.get<Head>(COL.outboxHead, 'head');
    if (!head) return;
    let upTo = head.seq - this.cfg().maxOutbox;
    if (sinks.length) {
      let min = Number.POSITIVE_INFINITY;
      for (const s of sinks) min = Math.min(min, (await this.state(s.id)).outboxSeq);
      upTo = Math.max(upTo, min);
    }
    if (upTo <= 0) return;
    for (let i = 0; i < 20; i++) {
      const page = await docs.list<OutboxEntry>(COL.outbox, { limit: 500 });
      const doomed = page.items.filter((x) => x.value.seq <= upTo);
      for (const d of doomed) await docs.delete(COL.outbox, d.key);
      if (doomed.length < page.items.length || !page.cursor) break;
    }
  }

  /** Send one synthetic record to a sink (does not move cursors). */
  async test(sinkId: string): Promise<{ ok: boolean; error?: string; ms: number }> {
    const cfg = this.cfg().sinks.find((s) => s.id === sinkId);
    if (!cfg) return { ok: false, error: 'No destination with that name', ms: 0 };
    const at = this.rt.now();
    const rec: SiemRecord = {
      id: `test:${at}`,
      stream: 'compliance',
      type: 'siem.test',
      at,
      node: this.nodeId(),
      relayId: null,
      summary: 'Beamhop test record — your SIEM connection works',
      chain: { log: 'compliance.events', seq: 0, prevHash: GENESIS, hash: GENESIS },
    };
    const started = this.rt.ports.clock.nowMs();
    try {
      await this.sinkFor(cfg).send([rec]);
      return { ok: true, ms: this.rt.ports.clock.nowMs() - started };
    } catch (err) {
      return { ok: false, error: errMsg(err), ms: this.rt.ports.clock.nowMs() - started };
    }
  }

  async close(): Promise<void> {
    for (const { sink } of this.sinks.values()) await sink.close?.().catch(() => {});
    this.sinks.clear();
  }
}
