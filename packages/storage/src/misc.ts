import type { AuditEntry, AuditLog, Db, Invite, InviteStore, IpRule, IpRuleStore, KvStore } from "@beamhop/sdk";
import { nowSec } from "@beamhop/sdk";
import { isUniqueViolation, parseJson, toNum, toNumOrNull } from "./sql";
import { upsertUser } from "./users";

// ---------------------------------------------------------------- invites

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Uniformly random base62 string (rejection sampling, no modulo bias). */
export function randomCode(length = 10): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && out.length < length) out += BASE62[b % 62];
    }
  }
  return out;
}

interface InviteRow {
  code: string;
  created_by: string;
  created_at: number;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  note: string;
}
const rowToInvite = (r: InviteRow): Invite => ({
  code: r.code,
  createdBy: r.created_by,
  createdAt: toNum(r.created_at),
  maxUses: toNum(r.max_uses),
  uses: toNum(r.uses),
  expiresAt: toNumOrNull(r.expires_at),
  note: r.note ?? "",
});

/** Invite codes. `maxUses` defaults to 1; `maxUses: 0` means unlimited uses. */
export class SqlInviteStore implements InviteStore {
  constructor(private db: Db) {}

  async create(input: { createdBy: string; maxUses?: number; expiresAt?: number | null; note?: string }): Promise<Invite> {
    for (let attempt = 0; ; attempt++) {
      const invite: Invite = {
        code: randomCode(10),
        createdBy: input.createdBy,
        createdAt: nowSec(),
        maxUses: Math.max(0, Math.floor(input.maxUses ?? 1)),
        uses: 0,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? "",
      };
      try {
        await this.db.run(
          "INSERT INTO invites (code, created_by, created_at, max_uses, uses, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [invite.code, invite.createdBy, invite.createdAt, invite.maxUses, 0, invite.expiresAt, invite.note],
        );
        return invite;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < 5) continue;
        throw err;
      }
    }
  }

  async list(): Promise<Invite[]> {
    return (await this.db.all<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC, code ASC")).map(rowToInvite);
  }

  async redeem(code: string, pubkey: string): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const consumed = await tx.run(
        "UPDATE invites SET uses = uses + 1 WHERE code = ? AND (max_uses = 0 OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)",
        [code, nowSec()],
      );
      if (consumed.changes !== 1) return false;
      const inv = await tx.get<{ created_by: string }>("SELECT created_by FROM invites WHERE code = ?", [code]);
      const existing = await tx.get<{ invited_by: string | null }>("SELECT invited_by FROM users WHERE pubkey = ?", [pubkey]);
      await upsertUser(tx, pubkey, {
        allowed: true,
        ...(existing?.invited_by ? {} : { invitedBy: inv!.created_by }),
      });
      return true;
    });
  }

  async revoke(code: string): Promise<void> {
    await this.db.run("DELETE FROM invites WHERE code = ?", [code]);
  }
}

// ---------------------------------------------------------------- ip rules

export class SqlIpRuleStore implements IpRuleStore {
  constructor(private db: Db) {}

  async list(): Promise<IpRule[]> {
    const rows = await this.db.all<{ cidr: string; action: string; reason: string; created_at: number }>(
      "SELECT cidr, action, reason, created_at FROM ip_rules ORDER BY created_at DESC, cidr ASC",
    );
    return rows.map((r) => ({
      cidr: r.cidr,
      action: r.action === "allow" ? "allow" : "block",
      reason: r.reason ?? "",
      createdAt: toNum(r.created_at),
    }));
  }

  /** Adds or replaces the rule for `cidr`. */
  async add(rule: Omit<IpRule, "createdAt">): Promise<void> {
    await this.db.run(
      "INSERT INTO ip_rules (cidr, action, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (cidr) DO UPDATE SET action = excluded.action, reason = excluded.reason",
      [rule.cidr.trim(), rule.action, rule.reason ?? "", nowSec()],
    );
  }

  async remove(cidr: string): Promise<void> {
    await this.db.run("DELETE FROM ip_rules WHERE cidr = ?", [cidr.trim()]);
  }
}

// ---------------------------------------------------------------- kv

export class SqlKvStore implements KvStore {
  constructor(private db: Db) {}

  async get<T = unknown>(namespace: string, key: string): Promise<T | undefined> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM kv WHERE namespace = ? AND key = ?", [namespace, key]);
    return row ? parseJson<T | undefined>(row.value, undefined) : undefined;
  }

  /** `undefined` values are stored as JSON null. */
  async set(namespace: string, key: string, value: unknown): Promise<void> {
    await this.db.run(
      "INSERT INTO kv (namespace, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [namespace, key, JSON.stringify(value ?? null), nowSec()],
    );
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", [namespace, key]);
  }

  async list<T = unknown>(namespace: string): Promise<Record<string, T>> {
    const rows = await this.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM kv WHERE namespace = ? ORDER BY key",
      [namespace],
    );
    const out: Record<string, T> = {};
    for (const r of rows) out[r.key] = parseJson<T>(r.value, null as T);
    return out;
  }
}

// ---------------------------------------------------------------- audit

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  details: string;
  ip: string | null;
}

/**
 * Append-only audit log. `list()` returns newest first (id DESC); `before` is an id cursor
 * (entries with id < before), `limit` defaults to 100 and is capped at 1000.
 */
export class SqlAuditLog implements AuditLog {
  constructor(private db: Db) {}

  async record(entry: Omit<AuditEntry, "id" | "at"> & { at?: number }): Promise<void> {
    await this.db.run("INSERT INTO audit_log (at, actor, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)", [
      entry.at ?? nowSec(),
      entry.actor,
      entry.action,
      entry.target ?? null,
      JSON.stringify(entry.details ?? {}),
      entry.ip ?? null,
    ]);
  }

  async list(q: { actor?: string; action?: string; target?: string; before?: number; limit?: number }): Promise<AuditEntry[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const [col, v] of [
      ["actor", q.actor],
      ["action", q.action],
      ["target", q.target],
    ] as const) {
      if (v === undefined || v === "") continue;
      conds.push(`${col} = ?`);
      params.push(v);
    }
    if (q.before !== undefined) {
      conds.push("id < ?");
      params.push(q.before);
    }
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 100)), 1000);
    const rows = await this.db.all<AuditRow>(
      `SELECT * FROM audit_log${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map((r) => ({
      id: toNum(r.id),
      at: toNum(r.at),
      actor: r.actor,
      action: r.action,
      target: r.target ?? null,
      details: parseJson<Record<string, unknown>>(r.details, {}),
      ip: r.ip ?? null,
    }));
  }
}
