// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Alerts engine: collects per-minute signals from the bus, evaluates rules
 * against EWMA/seasonal baselines, and manages alert lifecycle:
 *
 * - Dedupe: one active alert per `rule:relay` key; repeats update it.
 * - Notify on first fire, on escalation, and again after `renotifyMinutes`.
 * - Cooldown/resolve: an alert resolves after 2 consecutive clear evaluations;
 *   a resolved alert can't re-notify within 15 minutes (flap guard).
 * - Mute (indefinite) / snooze (until a time) per rule, per relay or all relays:
 *   suppresses both notifications and cards.
 */
import type { AttentionCard, Kernel, Notification, RelayId } from '@beamhop/core';
import { readDisk } from '@beamhop/insights';
import { Baseline, type BaselineState } from './baseline.ts';
import type { AlertsModuleConfig } from './config.ts';
import { BUILTIN_RULES, type Category, type Rule, type RuleHit, type Signals } from './rules.ts';

export const ACTIVE_COLLECTION = 'alerts.active';
export const HISTORY_COLLECTION = 'alerts.history';
export const MUTES_COLLECTION = 'alerts.mutes';
export const BASELINE_COLLECTION = 'alerts.baselines';
export const CHANGES_COLLECTION = 'alerts.changes';

export const RESOLVE_AFTER = 2;
export const FLAP_GUARD_SECONDS = 15 * 60;
export const NODE_KEY = '*';

export interface AlertRecord extends RuleHit {
  id: string;
  key: string;
  rule: string;
  category: Category;
  relayId: RelayId | null;
  firstAt: number;
  lastAt: number;
  count: number;
  notifiedAt?: number;
  notifiedSeverity?: RuleHit['severity'];
  clearStreak: number;
  resolvedAt?: number;
}

export interface MuteRecord {
  rule: string;
  relayId: RelayId | null | '*all';
  /** null = muted until turned back on. */
  until: number | null;
  by: string;
  at: number;
}

export type AlertListener = (n: Notification & { key: string; category: Category }) => void;

export function alertKey(rule: string, relayId: RelayId | null): string {
  return `${rule}:${relayId ?? NODE_KEY}`;
}

export function muteKey(rule: string, relayId: RelayId | null | '*all'): string {
  return relayId === '*all' ? rule : alertKey(rule, relayId);
}

const SIGNALS: Array<keyof Signals> = [
  'rejectedPerMin',
  'errorsPerMin',
  'acceptedPerMin',
  'connections',
];

interface Counters {
  rejected: number;
  errors: number;
  accepted: number;
  connections: number;
}

interface EngineLike {
  connectionCount?(relayId?: RelayId): number;
}

export class AlertsEngine {
  readonly rules: Rule[] = [...BUILTIN_RULES];
  private counters = new Map<RelayId, Counters>();
  private baselines = new Map<string, Baseline>();
  private baselinesLoaded: Promise<void> | null = null;
  private lastEval: number;
  private evals = 0;
  private listeners = new Set<AlertListener>();
  private recentResolved = new Map<string, number>();
  private storageSamples: Array<{ t: number; v: number }> = [];
  private cleanup: Array<() => void> = [];

  constructor(
    readonly kernel: Kernel,
    readonly config: () => AlertsModuleConfig,
    private notify: (n: Notification) => Promise<unknown>,
  ) {
    this.lastEval = kernel.ports.clock.now();
    const c = (relayId: RelayId) => {
      let x = this.counters.get(relayId);
      if (!x) {
        x = { rejected: 0, errors: 0, accepted: 0, connections: 0 };
        this.counters.set(relayId, x);
      }
      return x;
    };
    const bus = kernel.bus;
    this.cleanup.push(
      bus.on('event.rejected', (p) => {
        // Duplicates are normal client behaviour, not spam.
        if (!p.reason.startsWith('duplicate')) c(p.relayId).rejected++;
      }),
      bus.on('event.accepted', (p) => {
        c(p.relayId).accepted++;
      }),
      bus.on('error', (p) => {
        if (p.relayId) c(p.relayId).errors++;
        else for (const r of kernel.config().relays) c(r.id).errors++;
      }),
      bus.on('conn.open', (p) => {
        c(p.relayId).connections++;
      }),
      bus.on('conn.close', (p) => {
        const x = c(p.relayId);
        x.connections = Math.max(0, x.connections - 1);
      }),
      bus.on('config.changed', (p) => {
        this.logChange(null, p.summary, p.principalId);
      }),
      bus.on('admin.action', (p) => {
        if (p.ok && !p.actionId.startsWith('alerts.'))
          this.logChange(p.relayId, p.summary, p.principalId);
      }),
    );
  }

  stop(): void {
    for (const f of this.cleanup.splice(0)) f();
    this.listeners.clear();
  }

  private logChange(relayId: RelayId | null, summary: string, principalId: string): void {
    const now = this.kernel.ports.clock.now();
    const key = `${String(now).padStart(12, '0')}:${this.kernel.ports.crypto.randomHex(4)}`;
    this.kernel.ports.docs
      .put(CHANGES_COLLECTION, key, { at: now, relayId, summary, principalId })
      .catch(() => undefined);
  }

  onAlert(fn: AlertListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called by the router for notifications from other modules (`kernel.notify`). */
  forwardExternal(n: Notification): void {
    // Only explicitly operational notifications may reach public consumers.
    if (n.category !== 'ops') return;
    this.emitAlert({ ...n, key: `external:${n.title}`, category: 'ops' });
  }

  private emitAlert(n: Notification & { key: string; category: Category }): void {
    if (n.category !== 'ops') return;
    for (const l of this.listeners) {
      try {
        l(n);
      } catch {
        // listeners never break evaluation
      }
    }
  }

  // ───────────────────────── baselines ─────────────────────────

  private async loadBaselines(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<BaselineState>(BASELINE_COLLECTION, {
        cursor,
        limit: 200,
      });
      for (const { key, value } of page.items) this.baselines.set(key, new Baseline(value));
      cursor = page.cursor;
    } while (cursor);
  }

  baseline(relayId: RelayId, signal: keyof Signals): Baseline {
    const key = `${relayId}:${signal}`;
    let b = this.baselines.get(key);
    if (!b) {
      b = new Baseline();
      this.baselines.set(key, b);
    }
    return b;
  }

  async saveBaselines(): Promise<void> {
    for (const [key, b] of this.baselines)
      await this.kernel.ports.docs.put(BASELINE_COLLECTION, key, b.toJSON());
  }

  // ───────────────────────── signals ─────────────────────────

  private takeSignals(now: number): Map<RelayId, Signals> {
    const elapsed = Math.max(1, now - this.lastEval);
    this.lastEval = now;
    const engine = this.kernel.use<EngineLike>('relay.engine');
    const out = new Map<RelayId, Signals>();
    for (const r of this.kernel.config().relays) {
      const c = this.counters.get(r.id) ?? { rejected: 0, errors: 0, accepted: 0, connections: 0 };
      const conns =
        engine && typeof engine.connectionCount === 'function'
          ? engine.connectionCount(r.id)
          : c.connections;
      out.set(r.id, {
        rejectedPerMin: (c.rejected * 60) / elapsed,
        errorsPerMin: (c.errors * 60) / elapsed,
        acceptedPerMin: (c.accepted * 60) / elapsed,
        connections: conns,
      });
      c.rejected = 0;
      c.errors = 0;
      c.accepted = 0;
    }
    return out;
  }

  private async storageSeries(now: number): Promise<Array<{ t: number; v: number }>> {
    const from = now - 24 * 3600;
    try {
      const pts = await this.kernel.ports.metrics.range({
        metric: 'storage.bytes',
        labels: { relay: '_node' },
        from,
        to: now,
        stepSeconds: 600,
        agg: 'last',
      });
      if (pts.length >= 6) return pts;
    } catch {
      // fall back to own samples
    }
    const last = this.storageSamples[this.storageSamples.length - 1];
    if (!last || now - last.t >= 600) {
      const s = await this.kernel.ports.events.stats();
      this.storageSamples.push({ t: now, v: s.bytes });
      if (this.storageSamples.length > 144) this.storageSamples.shift();
    }
    return this.storageSamples.filter((p) => p.t >= from);
  }

  // ───────────────────────── evaluation ─────────────────────────

  async evaluate(): Promise<AlertRecord[]> {
    if (!this.baselinesLoaded) this.baselinesLoaded = this.loadBaselines();
    await this.baselinesLoaded;
    const k = this.kernel;
    const now = k.ports.clock.now();
    const cfg = this.config();
    const signals = this.takeSignals(now);
    const relays = k.config().relays.map((r) => r.id);
    const fired: AlertRecord[] = [];
    let storage: Promise<Array<{ t: number; v: number }>> | null = null;
    let disk: ReturnType<typeof readDisk> | null = null;

    for (const rule of this.rules) {
      if (!rule.enabled(cfg)) continue;
      const scopes: Array<RelayId | null> = rule.scope === 'node' ? [null] : relays;
      for (const relayId of scopes) {
        const sig = (relayId && signals.get(relayId)) || {
          rejectedPerMin: 0,
          errorsPerMin: 0,
          acceptedPerMin: 0,
          connections: 0,
        };
        let hit: RuleHit | null = null;
        try {
          hit = await rule.evaluate({
            kernel: k,
            cfg,
            now,
            relayId,
            signals: sig,
            baseline: (s) => this.baseline(relayId ?? NODE_KEY, s),
            storageSeries: () => {
              storage ??= this.storageSeries(now);
              return storage;
            },
            disk: () => {
              disk ??= readDisk(k);
              return disk;
            },
          });
        } catch (err) {
          k.bus.emit('error', { source: `alerts.rule.${rule.id}`, message: String(err) });
          continue;
        }
        const rec = await this.apply(rule, relayId, hit, now);
        if (rec) fired.push(rec);
      }
    }

    // Learn after judging, so a spike is scored against the old normal.
    for (const [relayId, s] of signals)
      for (const name of SIGNALS) this.baseline(relayId, name).update(s[name], now);
    if (++this.evals % 10 === 0) await this.saveBaselines();
    return fired;
  }

  private async apply(
    rule: Rule,
    relayId: RelayId | null,
    hit: RuleHit | null,
    now: number,
  ): Promise<AlertRecord | null> {
    const docs = this.kernel.ports.docs;
    const key = alertKey(rule.id, relayId);
    const existing = await docs.get<AlertRecord>(ACTIVE_COLLECTION, key);
    if (!hit) {
      if (!existing) return null;
      existing.clearStreak++;
      if (existing.clearStreak >= RESOLVE_AFTER) {
        existing.resolvedAt = now;
        await docs.delete(ACTIVE_COLLECTION, key);
        await docs.put(
          HISTORY_COLLECTION,
          `${String(existing.firstAt).padStart(12, '0')}:${existing.id}`,
          existing,
        );
        this.recentResolved.set(key, now);
      } else await docs.put(ACTIVE_COLLECTION, key, existing);
      return null;
    }
    const rec: AlertRecord = existing
      ? { ...existing, ...hit, lastAt: now, count: existing.count + 1, clearStreak: 0 }
      : {
          ...hit,
          id: this.kernel.ports.crypto.randomHex(8),
          key,
          rule: rule.id,
          category: rule.category,
          relayId,
          firstAt: now,
          lastAt: now,
          count: 1,
          clearStreak: 0,
        };
    const cfg = this.config();
    const escalated =
      rec.notifiedSeverity !== undefined &&
      rec.notifiedSeverity === 'warning' &&
      hit.severity === 'critical';
    const flapped = !existing && now - (this.recentResolved.get(key) ?? 0) < FLAP_GUARD_SECONDS;
    const due =
      rec.notifiedAt === undefined
        ? !flapped
        : escalated || now - rec.notifiedAt >= cfg.renotifyMinutes * 60;
    const muted = await this.isMuted(rule.id, relayId, now);
    let notified = false;
    if (due && !muted) {
      rec.notifiedAt = now;
      rec.notifiedSeverity = hit.severity;
      notified = true;
    }
    await docs.put(ACTIVE_COLLECTION, key, rec);
    if (notified) {
      const n: Notification = {
        severity: rec.severity,
        title: rec.title,
        body: rec.body,
        category: rec.category,
        ...(relayId ? { relayId } : {}),
        ...(this.alertUrl(rec) ? { url: this.alertUrl(rec) } : {}),
      };
      await this.notify(n);
      this.emitAlert({ ...n, key, category: rec.category });
      return rec;
    }
    return null;
  }

  alertUrl(rec: Pick<AlertRecord, 'id' | 'relayId'>): string | undefined {
    const relays = this.kernel.config().relays;
    const relay = (rec.relayId && relays.find((r) => r.id === rec.relayId)) || relays[0];
    const host = relay?.hosts[0];
    return host ? `https://${host}/admin/?alert=${rec.id}` : undefined;
  }

  // ───────────────────────── mutes ─────────────────────────

  async isMuted(rule: string, relayId: RelayId | null, now: number): Promise<boolean> {
    const docs = this.kernel.ports.docs;
    for (const k of [alertKey(rule, relayId), rule]) {
      const m = await docs.get<MuteRecord>(MUTES_COLLECTION, k);
      if (m && (m.until === null || m.until > now)) return true;
    }
    return false;
  }

  async listMutes(now: number): Promise<MuteRecord[]> {
    const out: MuteRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<MuteRecord>(MUTES_COLLECTION, {
        cursor,
        limit: 200,
      });
      for (const { value } of page.items)
        if (value.until === null || value.until > now) out.push(value);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  async active(): Promise<AlertRecord[]> {
    const out: AlertRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<AlertRecord>(ACTIVE_COLLECTION, {
        cursor,
        limit: 200,
      });
      out.push(...page.items.map((i) => i.value));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  async history(since: number, limit = 100): Promise<AlertRecord[]> {
    const page = await this.kernel.ports.docs.list<AlertRecord>(HISTORY_COLLECTION, {
      reverse: true,
      limit,
    });
    return page.items.map((i) => i.value).filter((a) => (a.resolvedAt ?? a.lastAt) >= since);
  }

  async changesSince(since: number, limit = 50) {
    const page = await this.kernel.ports.docs.list<{
      at: number;
      relayId: RelayId | null;
      summary: string;
      principalId: string;
    }>(CHANGES_COLLECTION, { reverse: true, limit });
    return page.items.map((i) => i.value).filter((c) => c.at >= since);
  }

  async pruneChanges(before: number): Promise<void> {
    const page = await this.kernel.ports.docs.list(CHANGES_COLLECTION, { limit: 1000 });
    for (const { key } of page.items)
      if (Number(key.split(':')[0]) < before)
        await this.kernel.ports.docs.delete(CHANGES_COLLECTION, key);
  }

  // ───────────────────────── cards ─────────────────────────

  async cards(relayId: RelayId | null): Promise<AttentionCard[]> {
    const now = this.kernel.ports.clock.now();
    const out: AttentionCard[] = [];
    for (const a of await this.active()) {
      const rule = this.rules.find((r) => r.id === a.rule);
      if (rule && !rule.card) continue;
      if (relayId && a.relayId && a.relayId !== relayId) continue;
      if (await this.isMuted(a.rule, a.relayId, now)) continue;
      out.push({
        id: `alerts:${a.key}`,
        relayId: a.relayId,
        severity: a.severity,
        title: a.title,
        body: a.body,
        technical: a.technical,
        batchKey: `alert:${a.rule}`,
        createdAt: a.firstAt,
        ...(a.playbook ? { playbook: a.playbook } : {}),
        primary: {
          label: 'Snooze for a day',
          actionId: 'alerts.snooze',
          input: { rule: a.rule, relayId: a.relayId, minutes: 1440 },
        },
        secondary: {
          label: 'Stop these alerts',
          actionId: 'alerts.mute',
          input: { rule: a.rule, relayId: a.relayId },
        },
      });
    }
    return out;
  }
}
