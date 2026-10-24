import type { Db, Migration } from "@beamhop/sdk";

export const GROUP_MIGRATIONS: Migration[] = [
  {
    id: "001_groups",
    up: `
CREATE TABLE IF NOT EXISTS core_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  is_private INTEGER NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_restricted INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS core_group_members (
  group_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, pubkey)
);
CREATE TABLE IF NOT EXISTS core_group_roles (
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (group_id, name)
);
CREATE TABLE IF NOT EXISTS core_group_invites (
  group_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, code)
);`,
  },
  {
    // ids of group control events whose state change was applied (replay protection, pruned by age)
    id: "002_group_applied",
    up: `
CREATE TABLE IF NOT EXISTS core_group_applied (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS core_group_applied_created_idx ON core_group_applied (created_at);`,
  },
  {
    // postgres INTEGER is 32-bit: unix timestamps overflow it in 2038 (sqlite INTEGER is already 64-bit)
    id: "003_bigint_timestamps",
    up: {
      sqlite: "SELECT 1",
      postgres: `
ALTER TABLE core_groups ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE core_group_members ALTER COLUMN added_at TYPE BIGINT;
ALTER TABLE core_group_invites ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE core_group_applied ALTER COLUMN created_at TYPE BIGINT;`,
    },
  },
];

/**
 * Applied-control records older than this are pruned. Control events from clients, sync and plugins
 * must be younger than GROUP_CONTROL_MAX_AGE_SEC, so older replays are refused before this check.
 */
const APPLIED_RETENTION_SEC = 60 * 60;

export interface GroupState {
  id: string;
  name: string;
  about: string;
  picture: string;
  private: boolean;
  closed: boolean;
  restricted: boolean;
  hidden: boolean;
  createdAt: number;
  createdBy: string;
  /** pubkey → roles */
  members: Map<string, string[]>;
  /** role name → description */
  roles: Map<string, string>;
  /** hashed invite codes ("sha256:<hex>") */
  invites: Set<string>;
  /** created_at of the last relay-signed metadata batch (kept strictly increasing) */
  lastMetaAt: number;
  /** being deleted: hidden from everyone until its events are purged (in memory only) */
  deleting?: boolean;
}

interface GroupRow {
  id: string;
  name: string;
  about: string;
  picture: string;
  is_private: number;
  is_closed: number;
  is_restricted: number;
  is_hidden: number;
  created_at: number;
  created_by: string;
}

/** Persistence for NIP-29 group state (write-through from the in-memory GroupsService). */
export class GroupRepo {
  private lastPrune = 0;

  constructor(private readonly db: Db) {}

  migrate() {
    return this.db.migrate("core", GROUP_MIGRATIONS);
  }

  async loadAll(): Promise<GroupState[]> {
    const groups = await this.db.all<GroupRow>("SELECT * FROM core_groups");
    const members = await this.db.all<{ group_id: string; pubkey: string; roles: string }>("SELECT group_id, pubkey, roles FROM core_group_members");
    const roles = await this.db.all<{ group_id: string; name: string; description: string }>("SELECT group_id, name, description FROM core_group_roles");
    const invites = await this.db.all<{ group_id: string; code: string }>("SELECT group_id, code FROM core_group_invites");
    const map = new Map<string, GroupState>();
    for (const r of groups) {
      map.set(r.id, {
        id: r.id,
        name: r.name,
        about: r.about,
        picture: r.picture,
        private: !!Number(r.is_private),
        closed: !!Number(r.is_closed),
        restricted: !!Number(r.is_restricted),
        hidden: !!Number(r.is_hidden),
        createdAt: Number(r.created_at),
        createdBy: r.created_by,
        members: new Map(),
        roles: new Map(),
        invites: new Set(),
        lastMetaAt: 0,
      });
    }
    for (const m of members) map.get(m.group_id)?.members.set(m.pubkey, safeArray(m.roles));
    for (const r of roles) map.get(r.group_id)?.roles.set(r.name, r.description);
    for (const i of invites) map.get(i.group_id)?.invites.add(i.code);
    return [...map.values()];
  }

  async saveGroup(g: GroupState): Promise<void> {
    await this.db.run(
      `INSERT INTO core_groups (id, name, about, picture, is_private, is_closed, is_restricted, is_hidden, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, about = excluded.about, picture = excluded.picture,
         is_private = excluded.is_private, is_closed = excluded.is_closed, is_restricted = excluded.is_restricted, is_hidden = excluded.is_hidden`,
      [g.id, g.name, g.about, g.picture, g.private ? 1 : 0, g.closed ? 1 : 0, g.restricted ? 1 : 0, g.hidden ? 1 : 0, g.createdAt, g.createdBy],
    );
  }

  async saveRoles(g: GroupState): Promise<void> {
    await this.db.tx(async (db) => {
      await db.run("DELETE FROM core_group_roles WHERE group_id = ?", [g.id]);
      for (const [name, description] of g.roles) {
        await db.run("INSERT INTO core_group_roles (group_id, name, description) VALUES (?, ?, ?)", [g.id, name, description]);
      }
    });
  }

  async putMember(groupId: string, pubkey: string, roles: string[], at: number): Promise<void> {
    await this.db.run(
      `INSERT INTO core_group_members (group_id, pubkey, roles, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (group_id, pubkey) DO UPDATE SET roles = excluded.roles`,
      [groupId, pubkey, JSON.stringify(roles), at],
    );
  }

  async removeMember(groupId: string, pubkey: string): Promise<void> {
    await this.db.run("DELETE FROM core_group_members WHERE group_id = ? AND pubkey = ?", [groupId, pubkey]);
  }

  async addInvite(groupId: string, code: string, createdBy: string, at: number): Promise<void> {
    await this.db.run(
      "INSERT INTO core_group_invites (group_id, code, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (group_id, code) DO NOTHING",
      [groupId, code, createdBy, at],
    );
  }

  async removeInvite(groupId: string, code: string): Promise<void> {
    await this.db.run("DELETE FROM core_group_invites WHERE group_id = ? AND code = ?", [groupId, code]);
  }

  /** Records a control event as applied; false if it already was (atomic). */
  async claimApplied(id: string, createdAt: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (Date.now() - this.lastPrune > 60_000) {
      this.lastPrune = Date.now();
      await this.db.run("DELETE FROM core_group_applied WHERE created_at < ?", [now - APPLIED_RETENTION_SEC]);
    }
    const r = await this.db.run("INSERT INTO core_group_applied (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING", [id, createdAt]);
    return r.changes > 0;
  }

  /** Forgets an applied-control record (its state change failed and may be retried). */
  async unclaimApplied(id: string): Promise<void> {
    await this.db.run("DELETE FROM core_group_applied WHERE id = ?", [id]);
  }

  /** Invite codes used to be stored in clear text; replaces them with their hashes. */
  async hashPlaintextInvites(hash: (code: string) => string): Promise<void> {
    const rows = await this.db.all<{ group_id: string; code: string }>("SELECT group_id, code FROM core_group_invites WHERE code NOT LIKE 'sha256:%'");
    for (const r of rows) {
      await this.db.run("UPDATE core_group_invites SET code = ? WHERE group_id = ? AND code = ?", [hash(r.code), r.group_id, r.code]);
    }
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.db.tx(async (db) => {
      for (const t of ["core_group_members", "core_group_roles", "core_group_invites"]) await db.run(`DELETE FROM ${t} WHERE group_id = ?`, [groupId]);
      await db.run("DELETE FROM core_groups WHERE id = ?", [groupId]);
    });
  }
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
