// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The enterprise identity service: SSO identities bound to npubs (§12.2),
 * group mapping (§12.4), offboarding (§12.5) and company identity (§12.6).
 * Exposed as `kernel.use<EnterpriseIdentityService>('enterprise.identity')`.
 */
import {
  type Kernel,
  type NostrEvent,
  type RelayId,
  type Role,
  tagValue,
  verifyEvent,
} from '@beamhop/core';
import type { EnterpriseIdentityConfig, IdpConfig, KeyModel } from './config.ts';
import { entitlementsOf, groupIdentifiers } from './mapping.ts';
import type { IdClaims } from './oidc.ts';
import type { Services } from './services.ts';
import type { TeamSessions } from './sessions.ts';
import { type Binding, COL, type IdentityStore, bindingKey } from './store.ts';
import { HEX64, sha256Hex, slug } from './util.ts';

export const LINK_KINDS = [22242, 27235] as const;
const CHALLENGE_TTL = 600;

export interface OffboardReport {
  bindingKey: string;
  pubkey?: string;
  status: 'suspended' | 'deleted';
  adminRevoked: boolean;
  sessionsClosed: number;
  connectionsClosed: number;
  allowlistsLeft: number;
  groupsTransferred: number;
  groupsLeft: number;
  blobsTransferred: number;
  keyDestructionAt?: number;
  successor?: string;
}

export interface DirectoryPerson {
  pubkey: string;
  name: string;
  email?: string;
  title?: string;
  department?: string;
  picture?: string;
}

interface ChallengeRecord {
  bindingKey: string;
  expiresAt: number;
}

export interface KeyDestructionRecord {
  subjectId: string;
  pubkey?: string;
  dueAt: number;
  status: 'scheduled' | 'held' | 'destroyed' | 'waiting-keyvault';
  updatedAt: number;
}

export class IdentityError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export class EnterpriseIdentityService {
  constructor(
    readonly kernel: Kernel,
    readonly cfg: () => EnterpriseIdentityConfig,
    readonly store: IdentityStore,
    readonly sessions: TeamSessions,
    readonly svc: Services,
  ) {}

  private now() {
    return this.kernel.ports.clock.now();
  }

  private log(msg: string, fields?: Record<string, unknown>) {
    this.kernel.ports.logger.log('info', msg, { module: 'enterprise-identity', ...fields });
  }

  idp(id: string): IdpConfig | undefined {
    return this.cfg().idps.find((i) => i.id === id);
  }

  // ───────────────────────── SSO upsert ─────────────────────────

  /**
   * Find (or create) the binding for a fresh SSO login. Correlates with records
   * provisioned earlier by SCIM / directory sync via subject, then verified email.
   */
  async upsertFromLogin(idp: IdpConfig, c: IdClaims): Promise<Binding> {
    const key = bindingKey(idp.id, c.subject);
    let b = await this.store.get(key);
    if (!b) b = await this.store.byAlias(`sub:${idp.id}:${c.subject}`);
    if (!b && c.email && c.emailVerified !== false) {
      const byMail = await this.store.byEmail(c.email);
      if (byMail && byMail.idp === idp.id) b = byMail;
    }
    const now = this.now();
    if (!b) {
      b = {
        idp: idp.id,
        subject: c.subject,
        groups: [],
        keyModel: this.cfg().defaultKeyModel,
        status: 'pending',
        source: 'oidc',
        createdAt: now,
        updatedAt: now,
      };
    }
    if (b.status === 'suspended' || b.status === 'deleted')
      throw new IdentityError(403, 'Your company account is not active on this workspace');
    const bk = bindingKey(b.idp, b.subject);
    if (bk !== key) await this.store.setAlias(`sub:${idp.id}:${c.subject}`, bk);
    if (c.email && !b.email) b.email = c.email;
    if (c.name) b.name = c.name;
    if (c.givenName) b.givenName = c.givenName;
    if (c.familyName) b.familyName = c.familyName;
    if (c.picture) b.picture = c.picture;
    if (!c.groupsOverage && c.groups.length) {
      // Token groups are authoritative for OIDC-only users; provisioned groups are kept too.
      b.groups = [...new Set([...(b.source === 'oidc' ? [] : b.groups), ...c.groups])];
    }
    b.keyModel = await this.keyModelOf(b);
    await this.store.put(b);
    return b;
  }

  async keyModelOf(b: Binding): Promise<KeyModel> {
    const ent = await entitlementsOf(this.store, b, (id) => this.kernel.relay(id));
    return ent.keyModel ?? this.cfg().defaultKeyModel;
  }

  /** Managed key model with a keyvault present → make sure the key exists and is bound. */
  async ensureManaged(b: Binding): Promise<Binding> {
    const kv = this.svc.keyvault();
    if (b.keyModel !== 'managed' || !kv || b.status === 'suspended' || b.status === 'deleted')
      return b;
    const pk = await kv.ensureKey(bindingKey(b.idp, b.subject));
    if (b.npub === pk && b.status === 'active') return b;
    return this.bindPubkey(b, pk, 'managed');
  }

  /** Effective mode for the team client: managed only when a keyvault can serve it. */
  modeOf(b: Binding): KeyModel {
    return b.keyModel === 'managed' && this.svc.keyvault() ? 'managed' : 'self-custody';
  }

  async bindPubkey(b: Binding, pubkey: string, model: KeyModel): Promise<Binding> {
    if (!HEX64.test(pubkey)) throw new IdentityError(400, 'That is not a valid public key');
    const key = bindingKey(b.idp, b.subject);
    const other = await this.store.byAlias(`pk:${pubkey}`);
    if (other && bindingKey(other.idp, other.subject) !== key && other.npub === pubkey)
      throw new IdentityError(409, 'This key is already linked to another person');
    const next: Binding = {
      ...b,
      npub: pubkey,
      keyModel: model,
      status: 'active',
      boundAt: this.now(),
    };
    await this.store.put(next);
    await this.store.unrevoke(pubkey);
    this.log('npub bound', { binding: key, keyModel: model });
    await this.afterChange();
    await this.syncProfile(next);
    return next;
  }

  // ───────────────────────── self-custody linking ─────────────────────────

  async createChallenge(key: string): Promise<{ challenge: string; expiresAt: number }> {
    const challenge = this.kernel.ports.crypto.randomHex(32);
    const expiresAt = this.now() + CHALLENGE_TTL;
    await this.kernel.ports.docs.put<ChallengeRecord>(COL.challenges, challenge, {
      bindingKey: key,
      expiresAt,
    });
    return { challenge, expiresAt };
  }

  /**
   * Verify a signed challenge (kind 22242 NIP-42 style, or 27235 NIP-98 style) with
   * a `challenge` tag, signed by the employee's own signer (NIP-07/46), then bind.
   */
  async verifyLink(key: string, event: NostrEvent): Promise<Binding> {
    if (!event || !LINK_KINDS.includes(event.kind as 22242 | 27235))
      throw new IdentityError(400, 'Sign the link request with your Nostr signer');
    if (!verifyEvent(event)) throw new IdentityError(400, 'The signature is not valid');
    if (Math.abs(event.created_at - this.now()) > CHALLENGE_TTL)
      throw new IdentityError(400, 'The signed request is too old, please try again');
    const challenge = tagValue(event, 'challenge');
    if (!challenge) throw new IdentityError(400, 'The signed request has no challenge');
    const docs = this.kernel.ports.docs;
    const rec = await docs.get<ChallengeRecord>(COL.challenges, challenge);
    if (!rec || rec.bindingKey !== key || rec.expiresAt < this.now())
      throw new IdentityError(400, 'The link request expired, please try again');
    if (!(await docs.delete(COL.challenges, challenge)))
      throw new IdentityError(400, 'The link request was already used');
    const b = await this.store.get(key);
    if (!b) throw new IdentityError(404, 'Unknown company account');
    if (b.status === 'suspended' || b.status === 'deleted')
      throw new IdentityError(403, 'Your company account is not active on this workspace');
    return this.bindPubkey(b, event.pubkey, 'self-custody');
  }

  // ───────────────────────── admin SSO ─────────────────────────

  async adminRoles(b: Binding): Promise<Record<RelayId | '*', Role>> {
    return (await entitlementsOf(this.store, b, (id) => this.kernel.relay(id))).roles;
  }

  adminId(b: Binding): string {
    return `sso:${b.idp}:${b.subject}`;
  }

  /** Create/refresh the admin record from group mapping and issue an admin session. */
  async issueAdminSession(b: Binding): Promise<{ token: string; expiresAt: number }> {
    const roles = await this.adminRoles(b);
    const dir = this.svc.adminDirectory();
    const sessions = this.svc.adminSessions();
    if (!dir || !sessions) throw new IdentityError(403, 'The admin app is not enabled here');
    const id = this.adminId(b);
    if (Object.keys(roles).length === 0) {
      await dir.remove(id);
      throw new IdentityError(403, 'Your company account has no admin role on this server');
    }
    const prev = await dir.get(id);
    const rec = {
      id,
      roles,
      createdAt: prev?.createdAt ?? this.now(),
      createdBy: prev?.createdBy ?? 'enterprise-identity',
      displayName: b.name ?? b.email ?? id,
      ...(b.npub ? { pubkey: b.npub } : {}),
    };
    await dir.put(rec);
    return sessions.issue(id, 'sso');
  }

  // ───────────────────────── offboarding ─────────────────────────

  private async successorFor(b: Binding, relayId: RelayId): Promise<string | undefined> {
    if (b.manager) {
      const m =
        (await this.store.byEmail(b.manager)) ??
        (await this.store.byScimId(b.manager)) ??
        (await this.store.get(bindingKey(b.idp, b.manager)));
      if (m?.npub && m.status === 'active') return m.npub;
    }
    return this.cfg().offboarding.successorPubkey ?? this.kernel.relay(relayId)?.info.pubkey;
  }

  /**
   * §12.5 cascade. Idempotent: running it again on an offboarded person is a no-op
   * besides refreshing the status.
   */
  async offboard(
    key: string,
    reason: string,
    status: 'suspended' | 'deleted' = 'suspended',
  ): Promise<OffboardReport> {
    const b = await this.store.get(key);
    const report: OffboardReport = {
      bindingKey: key,
      status,
      adminRevoked: false,
      sessionsClosed: 0,
      connectionsClosed: 0,
      allowlistsLeft: 0,
      groupsTransferred: 0,
      groupsLeft: 0,
      blobsTransferred: 0,
    };
    if (!b) return report;
    const pubkey = b.npub;
    if (pubkey) report.pubkey = pubkey;
    const wasActive = b.status !== 'suspended' && b.status !== 'deleted';

    // 1. Revoke immediately: unbind + revocation list (checked on every read/write).
    const next: Binding = { ...b, status, offboardedAt: b.offboardedAt ?? this.now() };
    if (pubkey) {
      next.previousNpub = pubkey;
      next.npub = undefined;
      await this.store.revoke({ pubkey, bindingKey: key, at: this.now(), reason });
    }
    await this.store.put(next);

    // Team + bunker sessions.
    report.sessionsClosed = (await this.sessions.revokeAll(key)).length;
    await this.svc
      .keyvault()
      ?.revokeSessions?.(key)
      ?.catch((err) => this.warn('bunker session revoke failed', err));

    // Live WebSocket sessions (relay hook if available; revocation list covers the rest).
    if (pubkey) {
      const eng = this.svc.engine();
      if (eng?.disconnectPubkey)
        report.connectionsClosed = await eng.disconnectPubkey(pubkey, reason);
    }

    // Admin sessions/tokens: dropping the admin record invalidates both.
    report.adminRevoked = await this.revokeAdmin(b, pubkey);

    if (pubkey) {
      const relays = this.kernel.config().relays.map((r) => r.id);
      // Allowlists.
      const policy = this.svc.policy();
      for (const r of relays)
        if (await policy?.state?.disallow?.(r, pubkey)?.catch(() => false)) report.allowlistsLeft++;
      policy?.clearTierCache?.();

      // NIP-29 groups: hand over admin roles, then leave.
      const groups = this.svc.groups();
      for (const r of groups ? relays : []) {
        const successor = await this.successorFor(b, r);
        if (successor && !report.successor) report.successor = successor;
        let list: Awaited<ReturnType<NonNullable<typeof groups>['list']>> = [];
        try {
          list = (await groups?.list(r)) ?? [];
        } catch (err) {
          this.warn('group listing failed', err);
        }
        for (const g of list) {
          const roles = g.members[pubkey];
          if (!roles) continue;
          if (roles.includes('admin') && successor && successor !== pubkey) {
            await groups?.addMembers(r, g.id, [{ pubkey: successor, roles: ['admin'] }]);
            report.groupsTransferred++;
          }
          await groups?.removeMembers(r, g.id, [pubkey]);
          report.groupsLeft++;
        }
      }

      // Files: ownership moves to the successor; data is kept (retention/legal hold).
      for (const r of relays) {
        const successor = await this.successorFor(b, r);
        if (!successor || successor === pubkey) continue;
        const owned = await this.kernel.ports.blobIndex.listByOwner(r, pubkey, { limit: 10_000 });
        for (const o of owned) {
          await this.kernel.ports.blobIndex.addOwner({ ...o, pubkey: successor });
          await this.kernel.ports.blobIndex.removeOwner(r, o.sha256, pubkey);
          report.blobsTransferred++;
        }
      }
    }

    // Managed key: crypto-shred after the grace period (legal holds block it).
    if (b.keyModel === 'managed' && (pubkey || b.previousNpub)) {
      const existing = await this.kernel.ports.docs.get<KeyDestructionRecord>(
        COL.keyDestruction,
        key,
      );
      const dueAt =
        existing?.dueAt ?? this.now() + this.cfg().offboarding.keyDestructionGraceDays * 86400;
      const pk = pubkey ?? b.previousNpub;
      await this.kernel.ports.docs.put<KeyDestructionRecord>(COL.keyDestruction, key, {
        subjectId: key,
        ...(pk ? { pubkey: pk } : {}),
        dueAt,
        status: existing?.status === 'destroyed' ? 'destroyed' : 'scheduled',
        updatedAt: this.now(),
      });
      report.keyDestructionAt = dueAt;
    }

    if (wasActive) await this.afterChange();
    this.log('person offboarded', {
      binding: key,
      reason,
      status,
      groups: report.groupsLeft,
      blobs: report.blobsTransferred,
    });
    return report;
  }

  private async revokeAdmin(b: Binding, pubkey: string | undefined): Promise<boolean> {
    const dir = this.svc.adminDirectory();
    if (!dir) return false;
    let revoked = await dir.remove(this.adminId(b));
    if (pubkey) {
      const rec = await dir.get(pubkey);
      if (rec) {
        const owners = (await dir.list()).filter((r) => r.roles['*'] === 'owner');
        if (rec.roles['*'] === 'owner' && owners.length <= 1) {
          this.kernel.ports.logger.log('warn', 'offboarded person is the only owner; kept', {
            module: 'enterprise-identity',
          });
        } else if (await dir.remove(pubkey)) revoked = true;
      }
    }
    return revoked;
  }

  private warn(msg: string, err: unknown) {
    this.kernel.ports.logger.log('warn', msg, {
      module: 'enterprise-identity',
      err: String(err),
    });
  }

  /** Re-enable a suspended person (SCIM `active: true`). They link their key again. */
  async reactivate(key: string): Promise<Binding | null> {
    const b = await this.store.get(key);
    if (!b) return null;
    if (b.status !== 'suspended' && b.status !== 'deleted') return b;
    const next: Binding = { ...b, status: 'pending', offboardedAt: undefined };
    await this.store.put(next);
    const kd = await this.kernel.ports.docs.get<KeyDestructionRecord>(COL.keyDestruction, key);
    if (kd && kd.status !== 'destroyed')
      await this.kernel.ports.docs.delete(COL.keyDestruction, key);
    this.log('person reactivated', { binding: key });
    return next;
  }

  /** Scheduled: destroy managed keys whose grace period is over, unless on legal hold. */
  async processKeyDestruction(): Promise<number> {
    const docs = this.kernel.ports.docs;
    const page = await docs.list<KeyDestructionRecord>(COL.keyDestruction, { limit: 1000 });
    let destroyed = 0;
    for (const { key, value } of page.items) {
      if (value.status === 'destroyed' || value.dueAt > this.now()) continue;
      const holds = this.svc.holds();
      const held = holds
        ? await holds.isHeld({
            subjectId: value.subjectId,
            ...(value.pubkey ? { pubkey: value.pubkey } : {}),
          })
        : false;
      let status: KeyDestructionRecord['status'];
      const kv = this.svc.keyvault();
      if (held) status = 'held';
      else if (!kv?.destroyKey) status = 'waiting-keyvault';
      else {
        await kv.destroyKey(value.subjectId, 'offboarding grace period over');
        status = 'destroyed';
        destroyed++;
      }
      await docs.put<KeyDestructionRecord>(COL.keyDestruction, key, {
        ...value,
        status,
        updatedAt: this.now(),
      });
    }
    return destroyed;
  }

  // ───────────────────────── company identity ─────────────────────────

  /** Things that depend on membership changed: re-sync channels. */
  async afterChange(): Promise<void> {
    if (!this.cfg().groupSync) return;
    try {
      await this.syncGroupChannels();
    } catch (err) {
      this.warn('group channel sync failed', err);
    }
  }

  /** IdP groups → NIP-29 groups (mappings with `channel: true`) on their write relays. */
  async syncGroupChannels(): Promise<number> {
    const groups = this.svc.groups();
    if (!groups) return 0;
    const mappings = (await this.store.mappings()).filter((m) => m.channel);
    if (!mappings.length) return 0;
    const people = (await this.store.list()).filter((b) => b.status === 'active' && b.npub);
    const idents = new Map<string, Set<string>>();
    for (const b of people)
      idents.set(bindingKey(b.idp, b.subject), await groupIdentifiers(this.store, b));
    let synced = 0;
    for (const m of mappings) {
      const members = people
        .filter(
          (b) =>
            (m.idp === '*' || m.idp === b.idp) &&
            idents.get(bindingKey(b.idp, b.subject))?.has(m.group.toLowerCase()),
        )
        .map((b) => b.npub as string);
      const id = slug(m.group);
      const known = m.idp !== '*' ? await this.findGroupName(m.idp, m.group) : undefined;
      for (const r of m.relays.filter((x) => x.access === 'write')) {
        if (!this.kernel.relay(r.relayId)) continue;
        const cur = await groups.get(r.relayId, id);
        if (!cur)
          await groups.create(r.relayId, {
            id,
            name: known ?? m.group,
            about: 'Synced from your company directory',
            private: true,
            closed: true,
          });
        await groups.setMembers(r.relayId, id, members);
        synced++;
      }
    }
    return synced;
  }

  private async findGroupName(idp: string, group: string): Promise<string | undefined> {
    const direct = await this.store.getGroup(idp, group);
    if (direct) return direct.displayName;
    const all = await this.store.listGroups(idp);
    const g = group.toLowerCase();
    return all.find(
      (x) =>
        x.displayName.toLowerCase() === g ||
        x.externalId?.toLowerCase() === g ||
        x.email?.toLowerCase() === g,
    )?.displayName;
  }

  nip05Name(b: Binding): string | undefined {
    if (!b.email) return undefined;
    const [local, domain] = b.email.toLowerCase().split('@');
    if (!local || !domain) return undefined;
    const want = this.cfg().nip05.domain?.toLowerCase();
    if (want && domain !== want) return undefined;
    return /^[a-z0-9._-]+$/.test(local) ? local : undefined;
  }

  profileOf(b: Binding): Record<string, string> {
    const p: Record<string, string> = {};
    const name = b.name ?? [b.givenName, b.familyName].filter(Boolean).join(' ');
    if (name) {
      p.name = name;
      p.display_name = name;
    }
    const about = [b.title, b.department].filter(Boolean).join(' · ');
    if (about) p.about = about;
    if (b.picture) p.picture = b.picture;
    const n = this.nip05Name(b);
    const domain = this.cfg().nip05.domain ?? b.email?.split('@')[1];
    if (n && domain && this.cfg().nip05.enabled) p.nip05 = `${n}@${domain}`;
    return p;
  }

  /**
   * Profile sync (§12.6): managed keys get a kind 0 signed by the keyvault and
   * published on the enterprise relays; self-custody users get a stored suggestion.
   */
  async syncProfile(b: Binding): Promise<'published' | 'suggested' | 'unchanged' | 'skipped'> {
    if (!this.cfg().profileSync || !b.npub || b.status !== 'active') return 'skipped';
    const key = bindingKey(b.idp, b.subject);
    const profile = this.profileOf(b);
    const content = JSON.stringify(profile);
    const hash = await sha256Hex(content);
    const docs = this.kernel.ports.docs;
    const prev = await docs.get<{ hash: string; mode: string }>(COL.profiles, key);
    const kv = this.svc.keyvault();
    const managed = b.keyModel === 'managed' && !!kv?.sign;
    if (prev?.hash === hash && prev.mode === (managed ? 'published' : 'suggested'))
      return 'unchanged';
    if (managed && kv?.sign) {
      const ev = await kv.sign(key, {
        kind: 0,
        pubkey: b.npub,
        created_at: this.now(),
        tags: [],
        content,
      });
      const eng = this.svc.engine();
      for (const r of this.cfg().relays) {
        const res = await this.kernel.ports.events.save(r, ev);
        if (res.status === 'saved') await eng?.broadcast?.(r, ev);
      }
      await docs.put(COL.profiles, key, { hash, mode: 'published', profile, at: this.now() });
      return 'published';
    }
    await docs.put(COL.profiles, key, { hash, mode: 'suggested', profile, at: this.now() });
    return 'suggested';
  }

  async profileSuggestion(key: string): Promise<Record<string, string> | null> {
    const rec = await this.kernel.ports.docs.get<{ profile: Record<string, string> }>(
      COL.profiles,
      key,
    );
    return rec?.profile ?? null;
  }

  /** NIP-05 `names` (+ `relays`) for `/.well-known/nostr.json`. */
  async nip05(name?: string): Promise<{
    names: Record<string, string>;
    relays: Record<string, string[]>;
  }> {
    const names: Record<string, string> = {};
    const relays: Record<string, string[]> = {};
    const urls = this.relayUrls();
    const add = (b: Binding | null) => {
      if (!b?.npub || b.status !== 'active') return;
      const n = this.nip05Name(b);
      if (!n || names[n]) return;
      names[n] = b.npub;
      if (urls.length) relays[b.npub] = urls;
    };
    const domain = this.cfg().nip05.domain;
    if (name !== undefined) {
      const n = name.toLowerCase();
      if (domain) add(await this.store.byEmail(`${n}@${domain}`));
      else for (const b of await this.store.list()) if (this.nip05Name(b) === n) add(b);
      return { names, relays };
    }
    const all = (await this.store.list()).sort((a, b) => a.createdAt - b.createdAt);
    for (const b of all) add(b);
    return { names, relays };
  }

  relayUrls(): string[] {
    const out: string[] = [];
    for (const id of this.cfg().relays) {
      const r = this.kernel.relay(id);
      const host = r?.hosts[0];
      if (!r || !host) continue;
      out.push(`wss://${host}${(r.pathPrefix ?? '').replace(/\/$/, '')}`);
    }
    return out;
  }

  async directory(): Promise<DirectoryPerson[]> {
    const people: DirectoryPerson[] = [];
    for (const b of await this.store.list()) {
      if (b.status !== 'active' || !b.npub) continue;
      const p: DirectoryPerson = {
        pubkey: b.npub,
        name: b.name ?? ([b.givenName, b.familyName].filter(Boolean).join(' ') || b.email || ''),
      };
      if (b.email) p.email = b.email;
      if (b.title) p.title = b.title;
      if (b.department) p.department = b.department;
      if (b.picture) p.picture = b.picture;
      people.push(p);
    }
    return people.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Contact-list seeding suggestion: people sharing a group with me, and the whole org. */
  async contactSuggestion(key: string): Promise<{ team: string[]; org: string[] }> {
    const me = await this.store.get(key);
    const all = (await this.store.list()).filter((b) => b.status === 'active' && b.npub);
    const mine = me ? await groupIdentifiers(this.store, me) : new Set<string>();
    const team: string[] = [];
    for (const b of all) {
      if (!b.npub || b.npub === me?.npub) continue;
      const theirs = await groupIdentifiers(this.store, b);
      if ([...theirs].some((g) => mine.has(g))) team.push(b.npub);
    }
    const org = all.map((b) => b.npub as string).filter((pk) => pk !== me?.npub);
    return { team, org };
  }
}
