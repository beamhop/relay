// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Isolated signer (§12.3). Managed private keys exist only envelope-encrypted
 * (`keyvault.keys/<subjectId>`); they are decrypted in memory for the duration
 * of one operation and the buffer is zeroized afterwards (best effort — the JS
 * runtime may keep transient copies). Every signature is rate-limited per key
 * and audited (`keyvault.audit` + bus `admin.action`).
 */
import type { Kernel, NostrEvent, RelayId } from '@beamhop/core';
import {
  getConversationKey,
  decrypt as nip44decrypt,
  encrypt as nip44encrypt,
} from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fromB64, toB64, zeroize } from './bytes.ts';
import type { KeyvaultConfig } from './config.ts';
import type { Envelope } from './envelope.ts';

export const KEYS_COLLECTION = 'keyvault.keys';
export const PUBKEYS_COLLECTION = 'keyvault.pubkeys';
export const AUDIT_COLLECTION = 'keyvault.audit';
export const DEFAULT_TENANT = 'default';

export type KeyStatus = 'active' | 'pending-destroy' | 'destroyed';

export interface KeyRecord {
  subjectId: string;
  pubkey: string;
  /** base64 envelope ciphertext of the 32-byte secret key; removed on crypto-shred. */
  wrappedSk?: string;
  tenant: string;
  createdAt: number;
  status: KeyStatus;
  destroyAfter?: number;
  destroyReason?: string;
  destroyedAt?: number;
  /** Set while a legal hold blocks a due destruction. */
  heldSince?: number;
}

export interface SignContext {
  sessionId?: string;
  /** Client app name or NIP-46 client pubkey. */
  client?: string;
  via?: 'bunker' | 'api' | 'profile-sync' | 'escrow' | 'admin';
  /** Admin principal for admin-initiated operations. */
  principalId?: string;
  reason?: string;
}

export type AuditOp =
  | 'sign'
  | 'nip44_encrypt'
  | 'nip44_decrypt'
  | 'escrow_decrypt'
  | 'create'
  | 'destroy'
  | 'destroy_scheduled'
  | 'destroy_blocked'
  | 'destroy_cancelled';

export interface AuditRecord {
  id: string;
  /** Unix ms. */
  at: number;
  op: AuditOp;
  subjectId: string;
  pubkey?: string;
  kind?: number;
  eventId?: string;
  sessionId?: string;
  client?: string;
  via?: string;
  principalId?: string;
  reason?: string;
  ok: boolean;
  error?: string;
}

export interface UnsignedInput {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
  pubkey?: string;
}

export class SignerError extends Error {
  constructor(
    readonly code: 'not-found' | 'inactive' | 'rate-limited' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export interface HoldsLike {
  isHeld(relayId: RelayId, subject: { pubkey?: string }): Promise<boolean> | boolean;
  active?(): boolean;
}

const SUBJECT_RE = /^[^\s/]{1,256}$/;

function describeKind(kind: number): string {
  if (kind === 0) return 'a profile update';
  if (kind === 1) return 'a post';
  if (kind === 3) return 'a contact list';
  if (kind === 7) return 'a reaction';
  if (kind === 13) return 'a private message seal';
  if (kind === 22242) return 'a sign-in';
  return `an event (kind ${kind})`;
}

export class Signer {
  readonly stats = { signed: 0, errors: 0, rateLimited: 0, since: 0 };
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastAnomaly = new Map<string, number>();
  /** Hook run after a key is crypto-shredded (bunker revokes sessions). */
  onDestroyed: Array<(subjectId: string) => Promise<void> | void> = [];

  constructor(
    private readonly kernel: Kernel,
    private readonly envelope: Envelope,
    private readonly cfg: () => KeyvaultConfig,
  ) {
    this.stats.since = kernel.ports.clock.nowMs();
  }

  private get docs() {
    return this.kernel.ports.docs;
  }

  // ───────────────────────── keys ─────────────────────────

  async record(subjectId: string): Promise<KeyRecord | null> {
    return this.docs.get<KeyRecord>(KEYS_COLLECTION, subjectId);
  }

  /** Create (first call) or return the managed keypair of a subject; returns the hex pubkey. */
  async ensureKey(subjectId: string, opts: { tenant?: string } = {}): Promise<string> {
    if (!SUBJECT_RE.test(subjectId)) throw new SignerError('invalid', 'invalid subject id');
    const existing = await this.record(subjectId);
    if (existing && existing.status !== 'destroyed') return existing.pubkey;
    const sk = generateSecretKey();
    try {
      const pubkey = getPublicKey(sk);
      const tenant = opts.tenant ?? existing?.tenant ?? DEFAULT_TENANT;
      const rec: KeyRecord = {
        subjectId,
        pubkey,
        wrappedSk: toB64(await this.envelope.encrypt(tenant, sk, `key:${subjectId}`)),
        tenant,
        createdAt: this.kernel.ports.clock.now(),
        status: 'active',
      };
      if (!(await this.docs.cas<KeyRecord>(KEYS_COLLECTION, subjectId, existing, rec))) {
        const won = await this.record(subjectId);
        if (won && won.status !== 'destroyed') return won.pubkey;
        throw new Error('could not create the managed key');
      }
      await this.docs.put(PUBKEYS_COLLECTION, pubkey, { subjectId });
      await this.audit({ op: 'create', subjectId, pubkey, ok: true });
      return pubkey;
    } finally {
      zeroize(sk);
    }
  }

  async pubkeyOf(subjectId: string): Promise<string | null> {
    const r = await this.record(subjectId);
    return r && r.status !== 'destroyed' ? r.pubkey : null;
  }

  async subjectOf(pubkey: string): Promise<string | null> {
    return (
      (await this.docs.get<{ subjectId: string }>(PUBKEYS_COLLECTION, pubkey))?.subjectId ?? null
    );
  }

  /** Is this pubkey a managed key whose secret still exists? (Self-custody keys never are.) */
  async isManaged(pubkey: string): Promise<boolean> {
    const subject = await this.subjectOf(pubkey);
    if (!subject) return false;
    const r = await this.record(subject);
    return !!r && r.pubkey === pubkey && r.status !== 'destroyed' && !!r.wrappedSk;
  }

  /** Keys whose due destruction is blocked by a legal hold. */
  async heldCount(): Promise<number> {
    let n = 0;
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<KeyRecord>(KEYS_COLLECTION, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const i of page.items)
        if (i.value.status === 'pending-destroy' && i.value.heldSince) n++;
      cursor = page.cursor;
    } while (cursor);
    return n;
  }

  async counts(): Promise<Record<KeyStatus, number>> {
    const out: Record<KeyStatus, number> = { active: 0, 'pending-destroy': 0, destroyed: 0 };
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<KeyRecord>(KEYS_COLLECTION, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const i of page.items) out[i.value.status]++;
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /**
   * Run `fn` with the decrypted secret key; the buffer is zeroized afterwards.
   * Internal: callers are the signer itself, the bunker (transport key) and escrow.
   */
  async withSecretKey<T>(
    subjectId: string,
    fn: (sk: Uint8Array, rec: KeyRecord) => T | Promise<T>,
    opts: { allowPendingDestroy?: boolean } = {},
  ): Promise<T> {
    const rec = await this.record(subjectId);
    if (!rec || !rec.wrappedSk || rec.status === 'destroyed')
      throw new SignerError('not-found', 'No managed key for this person');
    if (rec.status === 'pending-destroy' && !opts.allowPendingDestroy)
      throw new SignerError('inactive', 'This key is scheduled for destruction and cannot sign');
    const sk = await this.envelope.decrypt(fromB64(rec.wrappedSk), `key:${subjectId}`);
    try {
      return await fn(sk, rec);
    } finally {
      zeroize(sk);
    }
  }

  // ───────────────────────── rate limits ─────────────────────────

  private take(subjectId: string): boolean {
    const per = this.cfg().signing.perMinute;
    const now = this.kernel.ports.clock.nowMs();
    const b = this.buckets.get(subjectId) ?? { tokens: per, at: now };
    b.tokens = Math.min(per, b.tokens + ((now - b.at) / 60_000) * per);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(subjectId, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(subjectId, b);
    if (this.buckets.size > 10_000) {
      const first = this.buckets.keys().next().value;
      if (first !== undefined && first !== subjectId) this.buckets.delete(first);
    }
    return true;
  }

  private anomaly(subjectId: string): void {
    const now = this.kernel.ports.clock.now();
    const last = this.lastAnomaly.get(subjectId) ?? 0;
    if (now - last < 600) return;
    this.lastAnomaly.set(subjectId, now);
    void this.kernel
      .notify({
        severity: 'warning',
        title: 'Unusual signing activity',
        body: `A company-managed key (${subjectId}) tried to sign more than ${this.cfg().signing.perMinute} times a minute. Extra requests were refused.`,
        category: 'safety',
      })
      .catch(() => {});
  }

  // ───────────────────────── operations ─────────────────────────

  async sign(
    subjectId: string,
    unsigned: UnsignedInput,
    ctx: SignContext = {},
  ): Promise<NostrEvent> {
    const base = { subjectId, kind: unsigned?.kind, ...this.ctxFields(ctx) };
    try {
      if (
        !unsigned ||
        !Number.isInteger(unsigned.kind) ||
        unsigned.kind < 0 ||
        unsigned.kind > 65535 ||
        typeof unsigned.content !== 'string' ||
        !Array.isArray(unsigned.tags) ||
        !unsigned.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
      )
        throw new SignerError('invalid', 'That event is not well-formed');
      if (!this.take(subjectId)) {
        this.stats.rateLimited++;
        this.anomaly(subjectId);
        throw new SignerError('rate-limited', 'Too many signatures in a short time; slow down');
      }
      const event = await this.withSecretKey(subjectId, (sk, rec) => {
        if (unsigned.pubkey && unsigned.pubkey !== rec.pubkey)
          throw new SignerError('invalid', 'The event names a different author');
        return finalizeEvent(
          {
            kind: unsigned.kind,
            content: unsigned.content,
            tags: unsigned.tags,
            created_at: unsigned.created_at ?? this.kernel.ports.clock.now(),
          },
          sk,
        ) as NostrEvent;
      });
      this.stats.signed++;
      await this.audit({ ...base, op: 'sign', pubkey: event.pubkey, eventId: event.id, ok: true });
      return event;
    } catch (err) {
      this.stats.errors++;
      await this.audit({ ...base, op: 'sign', ok: false, error: errMsg(err) });
      throw err;
    }
  }

  async nip44Encrypt(
    subjectId: string,
    peerPubkey: string,
    plaintext: string,
    ctx: SignContext = {},
  ): Promise<string> {
    return this.cryptOp('nip44_encrypt', subjectId, ctx, (sk) => {
      const ck = getConversationKey(sk, peerPubkey);
      try {
        return nip44encrypt(plaintext, ck);
      } finally {
        zeroize(ck);
      }
    });
  }

  async nip44Decrypt(
    subjectId: string,
    peerPubkey: string,
    ciphertext: string,
    ctx: SignContext = {},
  ): Promise<string> {
    return this.cryptOp('nip44_decrypt', subjectId, ctx, (sk) => {
      const ck = getConversationKey(sk, peerPubkey);
      try {
        return nip44decrypt(ciphertext, ck);
      } finally {
        zeroize(ck);
      }
    });
  }

  private async cryptOp(
    op: 'nip44_encrypt' | 'nip44_decrypt',
    subjectId: string,
    ctx: SignContext,
    fn: (sk: Uint8Array) => string,
  ): Promise<string> {
    const base = { op, subjectId, ...this.ctxFields(ctx) } as const;
    try {
      if (!this.take(subjectId)) {
        this.stats.rateLimited++;
        this.anomaly(subjectId);
        throw new SignerError('rate-limited', 'Too many requests in a short time; slow down');
      }
      const out = await this.withSecretKey(subjectId, fn);
      await this.audit({ ...base, ok: true });
      return out;
    } catch (err) {
      this.stats.errors++;
      await this.audit({ ...base, ok: false, error: errMsg(err) });
      throw err;
    }
  }

  private ctxFields(ctx: SignContext): Partial<AuditRecord> {
    const out: Partial<AuditRecord> = {};
    if (ctx.sessionId) out.sessionId = ctx.sessionId;
    if (ctx.client) out.client = ctx.client;
    if (ctx.via) out.via = ctx.via;
    if (ctx.principalId) out.principalId = ctx.principalId;
    if (ctx.reason) out.reason = ctx.reason;
    return out;
  }

  // ───────────────────────── destruction (crypto-shred) ─────────────────────────

  private async held(pubkey: string): Promise<boolean> {
    const holds = this.kernel.use<HoldsLike>('lifecycle.holds');
    if (!holds || (holds.active && !holds.active())) return false;
    const relays = this.kernel.config().relays.map((r) => r.id);
    for (const relayId of relays.length ? relays : ['*']) {
      try {
        if (await holds.isHeld(relayId, { pubkey })) return true;
      } catch {
        return true; // fail safe: an unanswerable hold check blocks destruction
      }
    }
    return false;
  }

  /**
   * Schedule (or perform) crypto-shredding of a subject's managed key.
   * `reason` as a string (identity module, after its own grace period) → due now.
   * Object form: `afterSeconds` defaults to `destroyGraceDays`.
   * Always blocked while a legal hold covers the pubkey.
   */
  async destroyKey(
    subjectId: string,
    opts: string | { afterSeconds?: number; reason?: string; principalId?: string } = {},
  ): Promise<{ status: 'destroyed' | 'scheduled' | 'held' | 'not-found'; destroyAfter?: number }> {
    const o = typeof opts === 'string' ? { afterSeconds: 0, reason: opts } : opts;
    const rec = await this.record(subjectId);
    if (!rec) return { status: 'not-found' };
    if (rec.status === 'destroyed') return { status: 'destroyed' };
    const now = this.kernel.ports.clock.now();
    const after = o.afterSeconds ?? this.cfg().destroyGraceDays * 86400;
    const destroyAfter = Math.min(rec.destroyAfter ?? Number.POSITIVE_INFINITY, now + after);
    const next: KeyRecord = { ...rec, status: 'pending-destroy', destroyAfter };
    if (o.reason) next.destroyReason = o.reason;
    await this.docs.put(KEYS_COLLECTION, subjectId, next);
    // Sessions stop signing as soon as destruction is scheduled.
    for (const h of this.onDestroyed) await h(subjectId);
    if (destroyAfter > now) {
      await this.audit({
        op: 'destroy_scheduled',
        subjectId,
        pubkey: rec.pubkey,
        ok: true,
        ...(o.reason ? { reason: o.reason } : {}),
        ...(o.principalId ? { principalId: o.principalId } : {}),
      });
      return { status: 'scheduled', destroyAfter };
    }
    return this.shred(next, o.principalId);
  }

  async cancelDestroy(subjectId: string, principalId?: string): Promise<boolean> {
    const rec = await this.record(subjectId);
    if (!rec || rec.status !== 'pending-destroy') return false;
    const { destroyAfter: _a, destroyReason: _r, heldSince: _h, ...rest } = rec;
    await this.docs.put<KeyRecord>(KEYS_COLLECTION, subjectId, { ...rest, status: 'active' });
    await this.audit({
      op: 'destroy_cancelled',
      subjectId,
      pubkey: rec.pubkey,
      ok: true,
      ...(principalId ? { principalId } : {}),
    });
    return true;
  }

  private async shred(
    rec: KeyRecord,
    principalId?: string,
  ): Promise<{ status: 'destroyed' | 'held'; destroyAfter?: number }> {
    const now = this.kernel.ports.clock.now();
    if (await this.held(rec.pubkey)) {
      if (!rec.heldSince) {
        await this.docs.put<KeyRecord>(KEYS_COLLECTION, rec.subjectId, { ...rec, heldSince: now });
        await this.audit({
          op: 'destroy_blocked',
          subjectId: rec.subjectId,
          pubkey: rec.pubkey,
          ok: false,
          error: 'legal hold',
        });
      }
      return { status: 'held', ...(rec.destroyAfter ? { destroyAfter: rec.destroyAfter } : {}) };
    }
    const { wrappedSk: _gone, heldSince: _h, ...rest } = rec;
    await this.docs.put<KeyRecord>(KEYS_COLLECTION, rec.subjectId, {
      ...rest,
      status: 'destroyed',
      destroyedAt: now,
    });
    await this.audit({
      op: 'destroy',
      subjectId: rec.subjectId,
      pubkey: rec.pubkey,
      ok: true,
      ...(rec.destroyReason ? { reason: rec.destroyReason } : {}),
      ...(principalId ? { principalId } : {}),
    });
    return { status: 'destroyed' };
  }

  /** Scheduled job: shred keys whose grace period is over (unless held). */
  async processDestruction(): Promise<number> {
    const now = this.kernel.ports.clock.now();
    let n = 0;
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<KeyRecord>(KEYS_COLLECTION, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const { value } of page.items) {
        if (value.status !== 'pending-destroy' || (value.destroyAfter ?? 0) > now) continue;
        if ((await this.shred(value)).status === 'destroyed') n++;
      }
      cursor = page.cursor;
    } while (cursor);
    return n;
  }

  // ───────────────────────── audit ─────────────────────────

  async audit(r: Omit<AuditRecord, 'id' | 'at'>): Promise<AuditRecord> {
    const at = this.kernel.ports.clock.nowMs();
    const id = `${String(at).padStart(15, '0')}-${this.kernel.ports.crypto.randomHex(4)}`;
    const rec: AuditRecord = { id, at, ...r };
    try {
      await this.docs.put(AUDIT_COLLECTION, id, rec);
    } catch (err) {
      this.kernel.ports.logger.log('error', 'keyvault audit write failed', { err: String(err) });
    }
    const who = r.client ? ` via ${r.client}` : '';
    const summary =
      r.op === 'sign'
        ? `${r.ok ? 'Signed' : 'Refused to sign'} ${describeKind(r.kind ?? -1)} for ${r.subjectId}${who}`
        : `${opLabel(r.op)} for ${r.subjectId}${who}${r.ok ? '' : ' (failed)'}`;
    this.kernel.bus.emit('admin.action', {
      relayId: null,
      actionId: `keyvault.${r.op}`,
      principalId:
        r.principalId ?? (r.sessionId ? `session:${r.sessionId}` : `keyvault:${r.subjectId}`),
      input: {
        subjectId: r.subjectId,
        ...(r.kind !== undefined ? { kind: r.kind } : {}),
        ...(r.eventId ? { eventId: r.eventId } : {}),
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(r.client ? { client: r.client } : {}),
        ...(r.via ? { via: r.via } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      },
      summary,
      ok: r.ok,
    });
    return rec;
  }

  async listAudit(
    opts: { subjectId?: string; limit?: number; op?: AuditOp } = {},
  ): Promise<AuditRecord[]> {
    const limit = opts.limit ?? 100;
    const out: AuditRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<AuditRecord>(AUDIT_COLLECTION, {
        reverse: true,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const { value } of page.items) {
        if (opts.subjectId && value.subjectId !== opts.subjectId) continue;
        if (opts.op && value.op !== opts.op) continue;
        out.push(value);
        if (out.length >= limit) return out;
      }
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /** Drop audit records older than the retention window (SIEM export keeps long-term copies). */
  async pruneAudit(): Promise<number> {
    const cutoff =
      this.kernel.ports.clock.nowMs() - this.cfg().signing.auditRetentionDays * 86400_000;
    const page = await this.docs.list<AuditRecord>(AUDIT_COLLECTION, { limit: 1000 });
    let n = 0;
    for (const { key, value } of page.items) {
      if (value.at >= cutoff) break;
      await this.docs.delete(AUDIT_COLLECTION, key);
      n++;
    }
    return n;
  }
}

function opLabel(op: AuditOp): string {
  switch (op) {
    case 'nip44_encrypt':
      return 'Encrypted a message';
    case 'nip44_decrypt':
      return 'Decrypted a message';
    case 'escrow_decrypt':
      return 'Compliance decrypted a private message';
    case 'create':
      return 'Created a company-managed key';
    case 'destroy':
      return 'Destroyed a company-managed key';
    case 'destroy_scheduled':
      return 'Scheduled destruction of a company-managed key';
    case 'destroy_blocked':
      return 'Legal hold blocked destroying a company-managed key';
    case 'destroy_cancelled':
      return 'Cancelled destruction of a company-managed key';
    default:
      return 'Key operation';
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
