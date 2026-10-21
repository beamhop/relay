// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Google Workspace directory sync (§12.1): polls the Admin SDK Directory API
 * (users, groups, members) with a service-account JWT (RS256 via WebCrypto /
 * `jose`, domain-wide delegation impersonating `adminEmail`).
 *
 * Delta detection: a fingerprint of the fields we use is stored per user and
 * per group (`enterprise.sync`); unchanged records are skipped. Users that are
 * `suspended`/`archived` are offboarded; users that disappear from the listing
 * (deleted in Google) are offboarded as deleted. Google user `id` equals the
 * OIDC `sub`, so bindings created at login and by sync are the same record.
 */
import { SignJWT, importPKCS8 } from 'jose';
import type { EnterpriseIdentityConfig } from './config.ts';
import type { FetchLike } from './oidc.ts';
import type { EnterpriseIdentityService } from './service.ts';
import { type Binding, COL, type DirectoryGroup, bindingKey } from './store.ts';
import { sha256Hex } from './util.ts';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DIRECTORY_API = 'https://admin.googleapis.com/admin/directory/v1';
export const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
];

export interface GoogleUser {
  id: string;
  primaryEmail: string;
  name?: { fullName?: string; givenName?: string; familyName?: string };
  suspended?: boolean;
  archived?: boolean;
  thumbnailPhotoUrl?: string;
  organizations?: Array<{ title?: string; department?: string; primary?: boolean }>;
  relations?: Array<{ type?: string; value?: string }>;
}

export interface GoogleGroup {
  id: string;
  email: string;
  name?: string;
}

export interface SyncReport {
  users: { seen: number; created: number; updated: number; unchanged: number };
  suspended: number;
  deleted: number;
  reactivated: number;
  groups: { seen: number; changed: number; removed: number };
}

type DirectorySyncConfig = EnterpriseIdentityConfig['google']['directorySync'];

export class GoogleDirectorySync {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private readonly identity: EnterpriseIdentityService,
    private readonly fetchImpl: FetchLike,
  ) {}

  private get cfg(): DirectorySyncConfig {
    return this.identity.cfg().google.directorySync;
  }

  private now() {
    return this.identity.kernel.ports.clock.now();
  }

  configured(): boolean {
    const c = this.cfg;
    return c.enabled && !!c.serviceAccountEmail && !!c.privateKey && !!c.adminEmail;
  }

  /** Service-account JWT bearer grant (RFC 7523). */
  async accessToken(): Promise<string> {
    if (this.token && this.token.exp - 60 > this.now()) return this.token.value;
    const c = this.cfg;
    if (!c.serviceAccountEmail || !c.privateKey || !c.adminEmail)
      throw new Error('Google directory sync needs a service account and an admin email');
    const key = await importPKCS8(c.privateKey.replace(/\\n/g, '\n'), 'RS256');
    const iat = this.now();
    const assertion = await new SignJWT({ scope: DIRECTORY_SCOPES.join(' ') })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(c.serviceAccountEmail)
      .setSubject(c.adminEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google refused the service account (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Google returned no access token');
    this.token = { value: body.access_token, exp: iat + (body.expires_in ?? 3600) };
    return body.access_token;
  }

  private async pages<T>(path: string, field: string, params: Record<string, string>) {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${DIRECTORY_API}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await this.fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${await this.accessToken()}` },
      });
      if (!res.ok) throw new Error(`Google directory request failed (${res.status}) ${path}`);
      const body = (await res.json()) as Record<string, unknown>;
      const items = body[field];
      if (Array.isArray(items)) out.push(...(items as T[]));
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  listUsers(): Promise<GoogleUser[]> {
    return this.pages<GoogleUser>('/users', 'users', {
      customer: this.cfg.customer,
      maxResults: '500',
      projection: 'full',
    });
  }

  listGroups(): Promise<GoogleGroup[]> {
    return this.pages<GoogleGroup>('/groups', 'groups', {
      customer: this.cfg.customer,
      maxResults: '200',
    });
  }

  listMembers(groupKey: string): Promise<Array<{ id?: string; email?: string; type?: string }>> {
    return this.pages(`/groups/${encodeURIComponent(groupKey)}/members`, 'members', {
      maxResults: '200',
      includeDerivedMembership: 'true',
    });
  }

  /** Lightweight check used by `enterprise.test-connection`. */
  async test(): Promise<{ users: number }> {
    const url = new URL(`${DIRECTORY_API}/users`);
    url.searchParams.set('customer', this.cfg.customer);
    url.searchParams.set('maxResults', '1');
    const res = await this.fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!res.ok) throw new Error(`Google directory request failed (${res.status})`);
    const body = (await res.json()) as { users?: unknown[] };
    return { users: body.users?.length ?? 0 };
  }

  private async fingerprint(v: unknown): Promise<string> {
    return sha256Hex(JSON.stringify(v));
  }

  async run(): Promise<SyncReport> {
    const identity = this.identity;
    const store = identity.store;
    const docs = identity.kernel.ports.docs;
    const idp = this.cfg.idp;
    const report: SyncReport = {
      users: { seen: 0, created: 0, updated: 0, unchanged: 0 },
      suspended: 0,
      deleted: 0,
      reactivated: 0,
      groups: { seen: 0, changed: 0, removed: 0 },
    };

    // Groups first, so user group refs are known.
    const groups = await this.listGroups();
    const memberOf = new Map<string, string[]>(); // google user id → group ids
    const seenGroups = new Set<string>();
    for (const g of groups) {
      report.groups.seen++;
      seenGroups.add(g.id);
      const members = (await this.listMembers(g.id)).filter(
        (m) => (m.type ?? 'USER') === 'USER' && m.id,
      );
      for (const m of members) {
        const list = memberOf.get(m.id as string) ?? [];
        list.push(g.id);
        memberOf.set(m.id as string, list);
      }
      const rec: DirectoryGroup = {
        idp,
        id: g.id,
        displayName: g.name ?? g.email,
        email: g.email.toLowerCase(),
        members: members.map((m) => bindingKey(idp, m.id as string)).sort(),
        source: 'google',
        updatedAt: this.now(),
      };
      const fp = await this.fingerprint([rec.displayName, rec.email, rec.members]);
      const prev = await docs.get<{ fp: string }>(COL.sync, `google-group:${idp}:${g.id}`);
      if (prev?.fp === fp) continue;
      await store.putGroup(rec);
      await docs.put(COL.sync, `google-group:${idp}:${g.id}`, { fp });
      report.groups.changed++;
    }
    for (const g of await store.listGroups(idp)) {
      if (g.source !== 'google' || seenGroups.has(g.id)) continue;
      await store.removeGroup(idp, g.id);
      await docs.delete(COL.sync, `google-group:${idp}:${g.id}`);
      report.groups.removed++;
    }

    // Users.
    const users = await this.listUsers();
    const seen = new Set<string>();
    let membershipChanged = report.groups.changed > 0 || report.groups.removed > 0;
    for (const u of users) {
      report.users.seen++;
      seen.add(u.id);
      const key = bindingKey(idp, u.id);
      const org = u.organizations?.find((o) => o.primary) ?? u.organizations?.[0];
      const manager = u.relations?.find((r) => r.type === 'manager')?.value;
      const fields = {
        email: u.primaryEmail.toLowerCase(),
        name: u.name?.fullName,
        givenName: u.name?.givenName,
        familyName: u.name?.familyName,
        title: org?.title,
        department: org?.department,
        picture: u.thumbnailPhotoUrl,
        manager: manager?.toLowerCase(),
        groups: (memberOf.get(u.id) ?? []).sort(),
        inactive: !!(u.suspended || u.archived),
      };
      const fp = await this.fingerprint(fields);
      const syncKey = `google-user:${idp}:${u.id}`;
      const prevFp = await docs.get<{ fp: string }>(COL.sync, syncKey);
      const existing = await store.get(key);
      if (prevFp?.fp === fp && existing) {
        report.users.unchanged++;
        continue;
      }
      const now = this.now();
      const b: Binding = existing
        ? { ...existing }
        : {
            idp,
            subject: u.id,
            groups: [],
            keyModel: identity.cfg().defaultKeyModel,
            status: 'pending',
            source: 'google',
            createdAt: now,
            updatedAt: now,
          };
      // A login before the first sync created the record; the directory owns it now.
      if (b.source === 'oidc') b.source = 'google';
      if (existing) report.users.updated++;
      else report.users.created++;
      const before = JSON.stringify([...(existing?.groups ?? [])].sort());
      b.email = fields.email;
      b.name = fields.name;
      b.givenName = fields.givenName;
      b.familyName = fields.familyName;
      b.title = fields.title;
      b.department = fields.department;
      b.picture = fields.picture;
      b.manager = fields.manager;
      b.groups = fields.groups;
      if (before !== JSON.stringify(b.groups)) membershipChanged = true;
      await store.put(b);
      b.keyModel = await identity.keyModelOf(b);
      await store.put(b);
      await docs.put(COL.sync, syncKey, { fp });

      const active = b.status === 'active' || b.status === 'pending';
      if (fields.inactive && active) {
        await identity.offboard(key, 'Suspended in Google Workspace');
        report.suspended++;
      } else if (!fields.inactive && !active) {
        await identity.reactivate(key);
        report.reactivated++;
      } else if (b.status === 'active') {
        await identity.syncProfile(b);
      }
    }

    // Deleted in Google: offboard.
    for (const b of await store.list()) {
      if (b.idp !== idp || b.source !== 'google' || seen.has(b.subject)) continue;
      if (b.status === 'deleted') continue;
      await identity.offboard(bindingKey(idp, b.subject), 'Deleted in Google Workspace', 'deleted');
      await docs.delete(COL.sync, `google-user:${idp}:${b.subject}`);
      report.deleted++;
    }

    if (membershipChanged) await identity.afterChange();
    await docs.put(COL.sync, `google-last:${idp}`, { at: this.now(), report });
    return report;
  }
}
