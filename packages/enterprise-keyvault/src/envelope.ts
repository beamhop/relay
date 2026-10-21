// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Envelope encryption (§12.3): every tenant has an AES-256-GCM data key (DEK);
 * DEKs are stored only wrapped by the key-encryption key (KEK) in
 * `keyvault.deks/<tenant>`. Rotating the KEK re-wraps DEKs; data encrypted
 * under a DEK never needs re-encrypting.
 *
 * Ciphertext layout: "BKV" 0x01 | tenantLen (1) | tenant | iv (12) | AES-GCM(ct+tag).
 * AAD = header bytes ‖ caller context (binds a ciphertext to its purpose, e.g. a subject).
 */
import type { Clock, DocStore, KeyWrapper } from '@beamhop/core';
import { buf, concat, fromB64, fromUtf8, toB64, utf8, zeroize } from './bytes.ts';
import type { KekProvider } from './kek/types.ts';

export const DEKS_COLLECTION = 'keyvault.deks';
export const NODE_TENANT = '_node';
const MAGIC = new Uint8Array([0x42, 0x4b, 0x56, 0x01]);
const IV_LEN = 12;

export interface DekRecord {
  tenant: string;
  /** base64 of the KEK-wrapped DEK. */
  wrapped: string;
  kekId: string;
  provider: string;
  createdAt: number;
  rotatedAt?: number;
}

export interface KekSet {
  current: KekProvider;
  previous: KekProvider[];
}

export interface RotationReport {
  total: number;
  rewrapped: number;
  alreadyCurrent: number;
  failed: Array<{ tenant: string; error: string }>;
}

export function isEnvelope(blob: Uint8Array): boolean {
  return blob.length > MAGIC.length && MAGIC.every((b, i) => blob[i] === b);
}

export class Envelope {
  private deks = new Map<string, Promise<CryptoKey>>();

  constructor(
    private readonly docs: DocStore,
    private readonly clock: Clock,
    private readonly keks: () => KekSet,
  ) {}

  private kekFor(id: string): KekProvider {
    const { current, previous } = this.keks();
    if (current.id === id) return current;
    const k = previous.find((p) => p.id === id);
    if (!k)
      throw new Error(
        `A data key is wrapped by a master key that is no longer configured (${id}); add it to previousKeks`,
      );
    return k;
  }

  private dek(tenant: string): Promise<CryptoKey> {
    let p = this.deks.get(tenant);
    if (!p) {
      p = this.loadDek(tenant);
      this.deks.set(tenant, p);
      p.catch(() => this.deks.delete(tenant));
    }
    return p;
  }

  private async importDek(raw: Uint8Array): Promise<CryptoKey> {
    try {
      return await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    } finally {
      zeroize(raw);
    }
  }

  private async loadDek(tenant: string): Promise<CryptoKey> {
    const existing = await this.docs.get<DekRecord>(DEKS_COLLECTION, tenant);
    if (existing) {
      const raw = await this.kekFor(existing.kekId).unwrap(fromB64(existing.wrapped));
      return this.importDek(raw);
    }
    const kek = this.keks().current;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const rec: DekRecord = {
      tenant,
      wrapped: toB64(await kek.wrap(raw)),
      kekId: kek.id,
      provider: kek.provider,
      createdAt: this.clock.now(),
    };
    if (await this.docs.cas<DekRecord>(DEKS_COLLECTION, tenant, null, rec))
      return this.importDek(raw);
    zeroize(raw);
    const won = await this.docs.get<DekRecord>(DEKS_COLLECTION, tenant);
    if (!won) throw new Error('could not create the data key');
    return this.importDek(await this.kekFor(won.kekId).unwrap(fromB64(won.wrapped)));
  }

  private header(tenant: string): Uint8Array {
    const t = utf8.encode(tenant);
    if (t.length === 0 || t.length > 255) throw new Error('invalid tenant');
    return concat(MAGIC, new Uint8Array([t.length]), t);
  }

  async encrypt(tenant: string, plaintext: Uint8Array, context = ''): Promise<Uint8Array> {
    const key = await this.dek(tenant);
    const header = this.header(tenant);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: buf(concat(header, utf8.encode(context))) },
      key,
      buf(plaintext),
    );
    return concat(header, iv, new Uint8Array(ct));
  }

  /** Tenant named in a ciphertext header. */
  tenantOf(blob: Uint8Array): string {
    if (!isEnvelope(blob)) throw new Error('not a keyvault ciphertext');
    const len = blob[MAGIC.length] as number;
    return fromUtf8.decode(blob.subarray(MAGIC.length + 1, MAGIC.length + 1 + len));
  }

  async decrypt(blob: Uint8Array, context = ''): Promise<Uint8Array> {
    const tenant = this.tenantOf(blob);
    const hlen = MAGIC.length + 1 + utf8.encode(tenant).length;
    const header = blob.subarray(0, hlen);
    const iv = blob.subarray(hlen, hlen + IV_LEN);
    const key = await this.dek(tenant);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(iv), additionalData: buf(concat(header, utf8.encode(context))) },
      key,
      buf(blob.subarray(hlen + IV_LEN)),
    );
    return new Uint8Array(pt);
  }

  async listDeks(): Promise<DekRecord[]> {
    const out: DekRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<DekRecord>(DEKS_COLLECTION, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const i of page.items) out.push(i.value);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /** DEKs still wrapped by a KEK other than the current one. */
  async pendingRotation(): Promise<number> {
    const id = this.keks().current.id;
    return (await this.listDeks()).filter((d) => d.kekId !== id).length;
  }

  /**
   * Re-wrap every DEK under the current KEK (the re-wrap job). `force` also
   * re-wraps DEKs already under the current KEK id (e.g. after a cloud KMS key
   * version rotation). Idempotent and safe to re-run after a partial failure.
   */
  async rotate(force = false): Promise<RotationReport> {
    const kek = this.keks().current;
    const report: RotationReport = { total: 0, rewrapped: 0, alreadyCurrent: 0, failed: [] };
    for (const rec of await this.listDeks()) {
      report.total++;
      if (rec.kekId === kek.id && !force) {
        report.alreadyCurrent++;
        continue;
      }
      let raw: Uint8Array | undefined;
      try {
        raw = await this.kekFor(rec.kekId).unwrap(fromB64(rec.wrapped));
        const next: DekRecord = {
          ...rec,
          wrapped: toB64(await kek.wrap(raw)),
          kekId: kek.id,
          provider: kek.provider,
          rotatedAt: this.clock.now(),
        };
        if (!(await this.docs.cas<DekRecord>(DEKS_COLLECTION, rec.tenant, rec, next)))
          throw new Error('changed concurrently; run the rotation again');
        report.rewrapped++;
      } catch (err) {
        report.failed.push({ tenant: rec.tenant, error: String((err as Error).message ?? err) });
      } finally {
        zeroize(raw);
      }
    }
    return report;
  }

  /**
   * The `KeyWrapper` port handed to other modules (alerts DM key, relay group
   * keys…): envelope-encrypts under the node tenant. Blobs that are not keyvault
   * ciphertexts are passed to `fallback` (a wrapper the runtime configured before).
   */
  portWrapper(fallback?: KeyWrapper): KeyWrapper {
    return {
      provider: 'keyvault',
      wrap: (pt) => this.encrypt(NODE_TENANT, pt, 'port'),
      unwrap: async (ct) => {
        if (isEnvelope(ct)) return this.decrypt(ct, 'port');
        if (fallback) return fallback.unwrap(ct);
        throw new Error('not a keyvault ciphertext');
      },
    };
  }
}
