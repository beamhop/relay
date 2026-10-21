// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Kernel, KeyWrapper, NostrEvent, RelayId } from '@beamhop/core';
import { Bunker } from './bunker.ts';
import { type FetchLike, defaultFetch, toHex } from './bytes.ts';
import { type KeyvaultConfig, KeyvaultConfigSchema, MODULE_ID } from './config.ts';
import { Envelope, type RotationReport } from './envelope.ts';
import { Escrow, type EscrowStatus } from './escrow.ts';
import { type KekProvider, createKek } from './kek/index.ts';
import { type MigrationReport, wrapLegacyKeys } from './migrate.ts';
import { type SignContext, Signer, type UnsignedInput } from './signer.ts';

export interface KeyvaultDeps {
  fetch?: FetchLike;
  env?: (name: string) => string | undefined;
  readFile?: (path: string) => Promise<string>;
}

/**
 * Public API, `kernel.use<KeyvaultService>('enterprise.keyvault')`.
 * `subjectId` is the identity binding key `<idp>:<subject>`.
 */
export interface KeyvaultService {
  ensureKey(subjectId: string, opts?: { tenant?: string }): Promise<string>;
  pubkeyOf(subjectId: string): Promise<string | null>;
  isManaged(pubkey: string): Promise<boolean>;
  bunkerUrlFor(sessionId: string, subjectId?: string, opts?: { perms?: string[] }): Promise<string>;
  bunkerPubkey(): Promise<string>;
  sign(subjectId: string, event: UnsignedInput, ctx?: SignContext): Promise<NostrEvent>;
  nip44Encrypt(
    subjectId: string,
    peer: string,
    plaintext: string,
    ctx?: SignContext,
  ): Promise<string>;
  nip44Decrypt(
    subjectId: string,
    peer: string,
    ciphertext: string,
    ctx?: SignContext,
  ): Promise<string>;
  revokeSessions(subjectId: string, sessionId?: string): Promise<void>;
  /**
   * Crypto-shred a subject's key. A string `reason` (identity module, after its own
   * grace period) means "now"; the object form schedules after `afterSeconds`
   * (default `destroyGraceDays`). Blocked while a legal hold applies — see `keyState`.
   */
  destroyKey(
    subjectId: string,
    opts?: string | { afterSeconds?: number; reason?: string },
  ): Promise<void>;
  /** Key lifecycle state, or null when the subject never had a managed key. */
  keyState(subjectId: string): Promise<{
    status: 'active' | 'pending-destroy' | 'destroyed';
    pubkey: string;
    destroyAfter?: number;
    held: boolean;
  } | null>;
  cancelDestroy(subjectId: string): Promise<boolean>;
  escrowStatus(pubkey: string, relayId?: RelayId): Promise<EscrowStatus>;
  /** Envelope-encrypt arbitrary data for a tenant (e.g. encryption at rest, §12.7). */
  encrypt(tenant: string, data: Uint8Array, context?: string): Promise<Uint8Array>;
  decrypt(blob: Uint8Array, context?: string): Promise<Uint8Array>;
}

export class KeyvaultRuntime {
  current: KekProvider | null = null;
  previous: KekProvider[] = [];
  initError: string | null = null;
  readonly envelope: Envelope;
  readonly signer: Signer;
  readonly bunker: Bunker;
  readonly escrow: Escrow;
  portWrapper: KeyWrapper | null = null;
  /** Wrapper the runtime configured before this module (kept for unwrapping old blobs). */
  priorWrapper: KeyWrapper | undefined;
  private probe: { at: number; ok: boolean; error?: string } | null = null;

  constructor(
    readonly kernel: Kernel,
    private readonly deps: KeyvaultDeps,
  ) {
    this.envelope = new Envelope(kernel.ports.docs, kernel.ports.clock, () => {
      if (!this.current)
        throw new Error(`The key vault is not ready: ${this.initError ?? 'no master key'}`);
      return { current: this.current, previous: this.previous };
    });
    this.signer = new Signer(kernel, this.envelope, () => this.cfg());
    this.bunker = new Bunker(kernel, this.signer, () => this.cfg());
    this.escrow = new Escrow(kernel, this.signer, () => this.cfg());
    this.signer.onDestroyed.push((s) => this.bunker.revokeSessions(s).then(() => {}));
  }

  cfg(): KeyvaultConfig {
    const raw = this.kernel.config().modules[MODULE_ID];
    return KeyvaultConfigSchema.parse(raw ?? {});
  }

  async init(): Promise<void> {
    const cfg = this.cfg();
    const deps = {
      fetch: this.deps.fetch ?? defaultFetch(),
      nowMs: () => this.kernel.ports.clock.nowMs(),
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(this.deps.readFile ? { readFile: this.deps.readFile } : {}),
    };
    try {
      this.current = await createKek(cfg.kek, deps);
      this.previous = [];
      for (const p of cfg.previousKeks) this.previous.push(await createKek(p, deps));
      this.initError = null;
    } catch (err) {
      this.current = null;
      this.initError = (err as Error).message ?? String(err);
      this.kernel.ports.logger.log('error', 'key vault master key unavailable', {
        module: MODULE_ID,
        err: this.initError,
      });
    }
    this.probe = null;
  }

  /** Probe the KEK (wrap + unwrap a random value), cached for 5 minutes. */
  async probeKek(force = false): Promise<{ ok: boolean; error?: string }> {
    const now = this.kernel.ports.clock.nowMs();
    if (!force && this.probe && now - this.probe.at < 300_000) return this.probe;
    let res: { ok: boolean; error?: string };
    if (!this.current) res = { ok: false, error: this.initError ?? 'no master key' };
    else {
      try {
        const v = crypto.getRandomValues(new Uint8Array(32));
        const back = await this.current.unwrap(await this.current.wrap(v));
        res = toHex(back) === toHex(v) ? { ok: true } : { ok: false, error: 'round-trip mismatch' };
      } catch (err) {
        res = { ok: false, error: (err as Error).message ?? String(err) };
      }
    }
    this.probe = { at: now, ...res };
    return res;
  }

  rotateKek(force = false): Promise<RotationReport> {
    return this.envelope.rotate(force);
  }

  migrateLegacy(opts?: {
    alertsKey?: boolean;
    relayGroupKeys?: boolean;
  }): Promise<MigrationReport> {
    if (!this.portWrapper) throw new Error('The key vault is not ready');
    const m = this.cfg().migrate;
    return wrapLegacyKeys(
      this.kernel.ports.docs,
      this.portWrapper,
      {
        alertsKey: opts?.alertsKey ?? m.alertsKey,
        relayGroupKeys: opts?.relayGroupKeys ?? m.relayGroupKeys,
      },
      this.priorWrapper,
    );
  }

  service(): KeyvaultService {
    const s = this.signer;
    return {
      ensureKey: (id, o) => s.ensureKey(id, o),
      pubkeyOf: (id) => s.pubkeyOf(id),
      isManaged: (pk) => s.isManaged(pk),
      bunkerUrlFor: (sid, subject, o) => this.bunker.bunkerUrlFor(sid, subject, o),
      bunkerPubkey: () => this.bunker.pubkey(),
      sign: (id, ev, ctx) => s.sign(id, ev, { via: 'api', ...ctx }),
      nip44Encrypt: (id, peer, pt, ctx) => s.nip44Encrypt(id, peer, pt, { via: 'api', ...ctx }),
      nip44Decrypt: (id, peer, ct, ctx) => s.nip44Decrypt(id, peer, ct, { via: 'api', ...ctx }),
      revokeSessions: async (id, sid) => {
        await this.bunker.revokeSessions(id, sid);
      },
      destroyKey: async (id, o) => {
        await s.destroyKey(id, o);
      },
      keyState: async (id) => {
        const r = await s.record(id);
        if (!r) return null;
        return {
          status: r.status,
          pubkey: r.pubkey,
          ...(r.destroyAfter !== undefined ? { destroyAfter: r.destroyAfter } : {}),
          held: !!r.heldSince,
        };
      },
      cancelDestroy: (id) => s.cancelDestroy(id),
      escrowStatus: (pk, relayId) => this.escrow.status(pk, relayId),
      encrypt: (tenant, data, ctx) => this.envelope.encrypt(tenant, data, `app:${ctx ?? ''}`),
      decrypt: (blob, ctx) => this.envelope.decrypt(blob, `app:${ctx ?? ''}`),
    };
  }
}
