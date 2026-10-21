// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Built-in NIP-46 remote signer ("bunker", §12.2). The relay itself hosts the
 * bunker: clients publish kind-24133 requests to this relay addressed (`p`) to
 * the bunker's transport key; the bunker sees them on the bus (`event.accepted`),
 * signs with the subject's managed key through the isolated signer and answers
 * with an ephemeral 24133 event via the relay engine's broadcast.
 *
 * Sessions: `bunkerUrlFor(sessionId, subjectId)` ties an SSO session to a
 * subject and hands out a one-time `secret`. `connect` with that secret binds
 * the client pubkey to the session; later requests are routed by client pubkey.
 * Every request re-checks that the SSO session is still active.
 */
import type { Kernel, NostrEvent, RelayId } from '@beamhop/core';
import {
  getConversationKey,
  decrypt as nip44decrypt,
  encrypt as nip44encrypt,
} from 'nostr-tools/nip44';
import { finalizeEvent } from 'nostr-tools/pure';
import { utf8, zeroize } from './bytes.ts';
import type { KeyvaultConfig } from './config.ts';
import { type Signer, SignerError, errMsg } from './signer.ts';

export const NIP46_KIND = 24133;
export const BUNKER_SUBJECT = 'keyvault:bunker';
export const SESSIONS_COLLECTION = 'keyvault.bunker.sessions';
export const SECRETS_COLLECTION = 'keyvault.bunker.secrets';
export const CLIENTS_COLLECTION = 'keyvault.bunker.clients';
export const BY_SUBJECT_COLLECTION = 'keyvault.bunker.subjects';

const SECRET_TTL_SECONDS = 3600;
const MAX_SKEW_SECONDS = 600;
const ALWAYS_ALLOWED = new Set(['connect', 'ping', 'get_public_key', 'logout', 'switch_relays']);

export interface BunkerSession {
  sessionId: string;
  subjectId: string;
  createdAt: number;
  /** Narrowing permissions (`sign_event`, `sign_event:<kind>`, `nip44_encrypt`, …); absent = all. */
  perms?: string[];
  revokedAt?: number;
}

export interface BunkerClient {
  sessionId: string;
  clientPubkey: string;
  connectedAt: number;
  /** Permissions requested by the client on `connect` (further narrowing). */
  perms?: string[];
  name?: string;
}

interface IdentityLike {
  isSessionActive?(sessionId: string, subjectId?: string): Promise<boolean> | boolean;
  sessions?: {
    list?(bindingKey: string): Promise<Array<{ sid: string; expiresAt: number }>>;
  };
}

interface EngineLike {
  broadcast(relayId: RelayId, event: NostrEvent): Promise<void> | void;
}

export class BunkerError extends Error {}

function parsePerms(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  const list = s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function permits(perms: string[] | undefined, method: string, kind?: number): boolean {
  if (!perms) return true;
  if (perms.includes(method)) return true;
  return kind !== undefined && perms.includes(`${method}:${kind}`);
}

export class Bunker {
  private pk: Promise<string> | null = null;
  private pkSync: string | null = null;
  private seen = new Set<string>();
  private inflight = new Set<Promise<void>>();

  constructor(
    private readonly kernel: Kernel,
    private readonly signer: Signer,
    private readonly cfg: () => KeyvaultConfig,
  ) {}

  private get docs() {
    return this.kernel.ports.docs;
  }

  private now(): number {
    return this.kernel.ports.clock.now();
  }

  /** The bunker's transport pubkey (a managed key of its own, created on first use). */
  pubkey(): Promise<string> {
    if (!this.pk) {
      this.pk = this.signer.ensureKey(BUNKER_SUBJECT, { tenant: '_node' }).then((pk) => {
        this.pkSync = pk;
        return pk;
      });
      this.pk.catch(() => {
        this.pk = null;
      });
    }
    return this.pk;
  }

  relayUrl(): string {
    const c = this.cfg().bunker;
    if (c.relayUrl) return c.relayUrl;
    const relays = this.kernel.config().relays;
    const relay = (c.relayId ? relays.find((r) => r.id === c.relayId) : undefined) ?? relays[0];
    const host = relay?.hosts.find((h) => !h.includes('*'));
    if (!relay || !host)
      throw new BunkerError(
        'Set the bunker relay address (bunker.relayUrl) in the key vault settings',
      );
    return `wss://${host}${relay.pathPrefix ?? ''}`;
  }

  // ───────────────────────── sessions ─────────────────────────

  async session(sessionId: string): Promise<BunkerSession | null> {
    return this.docs.get<BunkerSession>(SESSIONS_COLLECTION, sessionId);
  }

  /**
   * `bunker://<bunker-pubkey>?relay=<wss>&secret=<one-time>` for an SSO session.
   * Each call issues a fresh one-time secret.
   */
  async bunkerUrlFor(
    sessionId: string,
    subjectId?: string,
    opts: { perms?: string[] } = {},
  ): Promise<string> {
    if (!this.cfg().bunker.enabled) throw new BunkerError('The built-in bunker is turned off');
    if (!sessionId) throw new BunkerError('A session id is required');
    const existing = await this.session(sessionId);
    if (existing?.revokedAt) throw new BunkerError('This session was signed out');
    if (existing && subjectId && existing.subjectId !== subjectId)
      throw new BunkerError('This session belongs to someone else');
    const subject = subjectId ?? existing?.subjectId;
    if (!subject) throw new BunkerError('Unknown session: pass the subject id');
    await this.signer.ensureKey(subject);
    if (!existing) {
      const rec: BunkerSession = { sessionId, subjectId: subject, createdAt: this.now() };
      if (opts.perms) rec.perms = opts.perms;
      await this.docs.put(SESSIONS_COLLECTION, sessionId, rec);
      await this.docs.put(BY_SUBJECT_COLLECTION, `${subject}/${sessionId}`, { sessionId });
    } else if (opts.perms) {
      await this.docs.put(SESSIONS_COLLECTION, sessionId, { ...existing, perms: opts.perms });
    }
    const secret = this.kernel.ports.crypto.randomHex(16);
    await this.docs.put(SECRETS_COLLECTION, await this.hash(secret), {
      sessionId,
      expiresAt: this.now() + SECRET_TTL_SECONDS,
    });
    const pk = await this.pubkey();
    const relay = encodeURIComponent(this.relayUrl());
    return `bunker://${pk}?relay=${relay}&secret=${secret}`;
  }

  private hash(secret: string): Promise<string> {
    return this.kernel.ports.crypto.sha256Hex(utf8.encode(`bunker-secret:${secret}`));
  }

  /** Drop bunker sessions (offboarding). Without `sessionId`: every session of the subject. */
  async revokeSessions(subjectId: string, sessionId?: string): Promise<number> {
    const ids: string[] = [];
    if (sessionId) ids.push(sessionId);
    else {
      let cursor: string | undefined;
      do {
        const page = await this.docs.list<{ sessionId: string }>(BY_SUBJECT_COLLECTION, {
          prefix: `${subjectId}/`,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        for (const i of page.items) ids.push(i.value.sessionId);
        cursor = page.cursor;
      } while (cursor);
    }
    let n = 0;
    for (const id of ids) {
      const s = await this.session(id);
      if (!s || s.subjectId !== subjectId) continue;
      if (!s.revokedAt) {
        await this.docs.put<BunkerSession>(SESSIONS_COLLECTION, id, {
          ...s,
          revokedAt: this.now(),
        });
        n++;
      }
    }
    // Unbind clients of those sessions.
    const revoked = new Set(ids);
    let cursor: string | undefined;
    do {
      const page = await this.docs.list<BunkerClient>(CLIENTS_COLLECTION, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const { key, value } of page.items)
        if (revoked.has(value.sessionId)) await this.docs.delete(CLIENTS_COLLECTION, key);
      cursor = page.cursor;
    } while (cursor);
    return n;
  }

  private async sessionActive(s: BunkerSession): Promise<boolean> {
    if (s.revokedAt) return false;
    const key = await this.signer.record(s.subjectId);
    if (!key || key.status !== 'active') return false;
    const identity = this.kernel.use<IdentityLike>('enterprise.identity');
    if (!identity) return true;
    if (typeof identity.isSessionActive === 'function')
      return !!(await identity.isSessionActive(s.sessionId, s.subjectId));
    if (identity.sessions?.list) {
      const now = this.now();
      const list = await identity.sessions.list(s.subjectId);
      return list.some((r) => r.sid === s.sessionId && r.expiresAt > now);
    }
    return true;
  }

  // ───────────────────────── protocol ─────────────────────────

  /** Bus hook: cheap kind/`p` checks first so unrelated events cost nothing. */
  onAccepted(relayId: RelayId, event: NostrEvent): void {
    if (event.kind !== NIP46_KIND || !this.cfg().bunker.enabled) return;
    const run = async () => {
      const pk = this.pkSync ?? (await this.pubkey());
      if (!event.tags.some((t) => t[0] === 'p' && t[1] === pk)) return;
      await this.handle(relayId, event);
    };
    const p = run().catch((err) =>
      this.kernel.ports.logger.log('warn', 'bunker request failed', { err: errMsg(err) }),
    );
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }

  /** Wait for in-flight requests (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async handle(relayId: RelayId, event: NostrEvent): Promise<void> {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    if (Math.abs(this.now() - event.created_at) > MAX_SKEW_SECONDS) return;

    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      const text = await this.signer.withSecretKey(BUNKER_SUBJECT, (sk) => {
        const ck = getConversationKey(sk, event.pubkey);
        try {
          return nip44decrypt(event.content, ck);
        } finally {
          zeroize(ck);
        }
      });
      req = JSON.parse(text);
    } catch {
      return; // not for us / undecryptable: stay silent
    }
    if (typeof req.id !== 'string' || typeof req.method !== 'string') return;
    const params = Array.isArray(req.params) ? req.params.map((p) => String(p)) : [];
    let response: { id: string; result?: string; error?: string };
    try {
      response = { id: req.id, result: await this.dispatch(event.pubkey, req.method, params) };
    } catch (err) {
      response = { id: req.id, error: friendly(err) };
    }
    await this.respond(relayId, event.pubkey, response);
  }

  private async respond(relayId: RelayId, clientPubkey: string, body: unknown): Promise<void> {
    const ev = await this.signer.withSecretKey(BUNKER_SUBJECT, (sk) => {
      const ck = getConversationKey(sk, clientPubkey);
      try {
        return finalizeEvent(
          {
            kind: NIP46_KIND,
            created_at: this.now(),
            tags: [['p', clientPubkey]],
            content: nip44encrypt(JSON.stringify(body), ck),
          },
          sk,
        ) as NostrEvent;
      } finally {
        zeroize(ck);
      }
    });
    const engine = this.kernel.use<EngineLike>('relay.engine');
    if (!engine) {
      this.kernel.ports.logger.log('warn', 'bunker: no relay engine to answer through');
      return;
    }
    // Ephemeral kind: delivered live to the client's subscription, never stored.
    await engine.broadcast(relayId, ev);
  }

  private async clientSession(
    clientPubkey: string,
  ): Promise<{ client: BunkerClient; session: BunkerSession }> {
    const client = await this.docs.get<BunkerClient>(CLIENTS_COLLECTION, clientPubkey);
    const session = client ? await this.session(client.sessionId) : null;
    if (!client || !session) throw new BunkerError('unauthorized: connect first');
    if (!(await this.sessionActive(session)))
      throw new BunkerError('unauthorized: your company sign-in has ended; sign in again');
    return { client, session };
  }

  private async connect(clientPubkey: string, params: string[]): Promise<string> {
    const [target, secret, perms, meta] = params;
    if (target && target !== (await this.pubkey())) throw new BunkerError('wrong remote signer');
    if (secret) {
      const h = await this.hash(secret);
      const s = await this.docs.get<{ sessionId: string; expiresAt: number }>(
        SECRETS_COLLECTION,
        h,
      );
      // One-time: delete before anything else so a replay cannot reuse it.
      if (s) await this.docs.delete(SECRETS_COLLECTION, h);
      if (!s || s.expiresAt < this.now())
        throw new BunkerError('unauthorized: invalid or used secret');
      const session = await this.session(s.sessionId);
      if (!session || !(await this.sessionActive(session)))
        throw new BunkerError('unauthorized: your company sign-in has ended; sign in again');
      const rec: BunkerClient = {
        sessionId: session.sessionId,
        clientPubkey,
        connectedAt: this.now(),
      };
      const p = parsePerms(perms);
      if (p) rec.perms = p;
      if (meta) {
        try {
          const name = (JSON.parse(meta) as { name?: unknown }).name;
          if (typeof name === 'string') rec.name = name.slice(0, 64);
        } catch {}
      }
      await this.docs.put(CLIENTS_COLLECTION, clientPubkey, rec);
      return 'ack';
    }
    // Reconnect of an already bound client.
    await this.clientSession(clientPubkey);
    return 'ack';
  }

  private async dispatch(clientPubkey: string, method: string, params: string[]): Promise<string> {
    if (method === 'connect') return this.connect(clientPubkey, params);
    if (method === 'ping') return 'pong';
    const { client, session } = await this.clientSession(clientPubkey);
    const kind =
      method === 'sign_event'
        ? (JSON.parse(params[0] ?? '{}') as { kind?: number }).kind
        : undefined;
    if (
      !ALWAYS_ALLOWED.has(method) &&
      !(permits(session.perms, method, kind) && permits(client.perms, method, kind))
    )
      throw new BunkerError(`not allowed: this session may not ${method.replace('_', ' ')}`);
    const ctx = {
      sessionId: session.sessionId,
      client: client.name ?? `nip46:${clientPubkey.slice(0, 16)}`,
      via: 'bunker' as const,
    };
    switch (method) {
      case 'get_public_key': {
        const pk = await this.signer.pubkeyOf(session.subjectId);
        if (!pk) throw new BunkerError('no key');
        return pk;
      }
      case 'sign_event': {
        const t = JSON.parse(params[0] ?? 'null') as {
          kind: number;
          content: string;
          tags: string[][];
          created_at?: number;
          pubkey?: string;
        } | null;
        if (!t) throw new BunkerError('missing event');
        if (this.cfg().bunker.deniedKinds.includes(t.kind))
          throw new BunkerError(`not allowed: kind ${t.kind} cannot be signed here`);
        const signed = await this.signer.sign(session.subjectId, t, ctx);
        return JSON.stringify(signed);
      }
      case 'nip44_encrypt':
        return this.signer.nip44Encrypt(session.subjectId, params[0] ?? '', params[1] ?? '', ctx);
      case 'nip44_decrypt':
        return this.signer.nip44Decrypt(session.subjectId, params[0] ?? '', params[1] ?? '', ctx);
      case 'nip04_encrypt':
      case 'nip04_decrypt':
        throw new BunkerError('not supported: use NIP-44 encryption');
      case 'logout':
        await this.docs.delete(CLIENTS_COLLECTION, clientPubkey);
        return 'ack';
      case 'switch_relays':
        return 'null';
      default:
        throw new BunkerError(`unknown method: ${method}`);
    }
  }

  /** Sync bunker pubkey if known (for status). */
  knownPubkey(): string | null {
    return this.pkSync;
  }
}

function friendly(err: unknown): string {
  if (err instanceof BunkerError || err instanceof SignerError) return err.message;
  if (err instanceof SyntaxError) return 'invalid request';
  return 'internal error';
}
