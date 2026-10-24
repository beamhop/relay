import type { Db } from "@beamhop/sdk";

export interface PasskeyRow {
  id: string;
  pubkey: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface RawPasskey {
  id: string;
  pubkey: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const parseJsonArray = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const fromRaw = (r: RawPasskey): PasskeyRow => ({
  id: r.id,
  pubkey: r.pubkey,
  publicKey: r.public_key,
  counter: Number(r.counter),
  transports: parseJsonArray(r.transports),
  name: r.name,
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
});

/** Password hashes, TOTP secrets and passkeys. Never expose raw rows over the API. */
export class CredentialService {
  constructor(
    private readonly db: Db,
    private readonly nowSec: () => number,
  ) {}

  /** `setAt`: when the password was last set (null for rows older than that column). */
  async getPassword(pubkey: string): Promise<{ hash: string; totpSecret: string | null; setAt: number | null } | undefined> {
    const r = await this.db.get<{ password_hash: string; totp_secret: string | null; password_set_at: number | string | null }>(
      "SELECT password_hash, totp_secret, password_set_at FROM admin_credentials WHERE pubkey = ?",
      [pubkey],
    );
    return r ? { hash: r.password_hash, totpSecret: r.totp_secret, setAt: r.password_set_at == null ? null : Number(r.password_set_at) } : undefined;
  }

  async setPassword(pubkey: string, hash: string): Promise<void> {
    const now = this.nowSec();
    const updated = await this.db.run("UPDATE admin_credentials SET password_hash = ?, updated_at = ?, password_set_at = ? WHERE pubkey = ?", [hash, now, now, pubkey]);
    if (!updated.changes) {
      await this.db.run("INSERT INTO admin_credentials (pubkey, password_hash, totp_secret, updated_at, password_set_at) VALUES (?, ?, NULL, ?, ?)", [
        pubkey,
        hash,
        now,
        now,
      ]);
    }
  }

  /**
   * Replaces a hash with a re-parameterized hash of the same password. Not a password change: `password_set_at` (and
   * so trusted devices and fresh-auth checks) stays, and a concurrent password change wins (the old hash must match).
   */
  async rehashPassword(pubkey: string, oldHash: string, newHash: string): Promise<boolean> {
    const r = await this.db.run("UPDATE admin_credentials SET password_hash = ? WHERE pubkey = ? AND password_hash = ?", [newHash, pubkey, oldHash]);
    return r.changes > 0;
  }

  /** `usedStep`: the time step of the code that enabled the secret (it counts as consumed). */
  async setTotp(pubkey: string, secret: string | null, usedStep: number | null = null): Promise<void> {
    await this.db.run("UPDATE admin_credentials SET totp_secret = ?, totp_last_step = ?, updated_at = ? WHERE pubkey = ?", [
      secret,
      usedStep,
      this.nowSec(),
      pubkey,
    ]);
  }

  /** Atomically marks a TOTP time step as used; false when it (or a later step) was already used. */
  async consumeTotpStep(pubkey: string, step: number): Promise<boolean> {
    const r = await this.db.run(
      "UPDATE admin_credentials SET totp_last_step = ? WHERE pubkey = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
      [step, pubkey, step],
    );
    return r.changes > 0;
  }

  async listPasskeys(pubkey: string): Promise<PasskeyRow[]> {
    const rows = await this.db.all<RawPasskey>("SELECT * FROM admin_passkeys WHERE pubkey = ? ORDER BY created_at ASC", [pubkey]);
    return rows.map(fromRaw);
  }

  async getPasskey(id: string): Promise<PasskeyRow | undefined> {
    const r = await this.db.get<RawPasskey>("SELECT * FROM admin_passkeys WHERE id = ?", [id]);
    return r ? fromRaw(r) : undefined;
  }

  async addPasskey(p: Omit<PasskeyRow, "createdAt" | "lastUsedAt">): Promise<void> {
    await this.db.run(
      "INSERT INTO admin_passkeys (id, pubkey, public_key, counter, transports, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      [p.id, p.pubkey, p.publicKey, p.counter, JSON.stringify(p.transports), p.name, this.nowSec()],
    );
  }

  async markPasskeyUsed(id: string, counter: number): Promise<void> {
    await this.db.run("UPDATE admin_passkeys SET counter = ?, last_used_at = ? WHERE id = ?", [counter, this.nowSec(), id]);
  }

  async deletePasskey(pubkey: string, id: string): Promise<boolean> {
    const r = await this.db.run("DELETE FROM admin_passkeys WHERE id = ? AND pubkey = ?", [id, pubkey]);
    return r.changes > 0;
  }

  /**
   * Drops every login factor of a pubkey (password, TOTP secret, passkeys) when its admin access ends, so a role granted
   * again later starts from scratch. Trusted-device cookies need no cleanup: they only count against a stored password
   * set before them, and the next password is set after them.
   */
  async deleteAll(pubkey: string): Promise<void> {
    await this.db.run("DELETE FROM admin_passkeys WHERE pubkey = ?", [pubkey]);
    await this.db.run("DELETE FROM admin_credentials WHERE pubkey = ?", [pubkey]);
  }
}
