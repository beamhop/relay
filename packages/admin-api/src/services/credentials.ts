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

  async getPassword(pubkey: string): Promise<{ hash: string; totpSecret: string | null } | undefined> {
    const r = await this.db.get<{ password_hash: string; totp_secret: string | null }>(
      "SELECT password_hash, totp_secret FROM admin_credentials WHERE pubkey = ?",
      [pubkey],
    );
    return r ? { hash: r.password_hash, totpSecret: r.totp_secret } : undefined;
  }

  async hasPassword(pubkey: string): Promise<boolean> {
    const r = await this.db.get<{ password_hash: string }>("SELECT password_hash FROM admin_credentials WHERE pubkey = ?", [pubkey]);
    return !!r?.password_hash;
  }

  async setPassword(pubkey: string, hash: string): Promise<void> {
    const now = this.nowSec();
    const updated = await this.db.run("UPDATE admin_credentials SET password_hash = ?, updated_at = ? WHERE pubkey = ?", [hash, now, pubkey]);
    if (!updated.changes) {
      await this.db.run("INSERT INTO admin_credentials (pubkey, password_hash, totp_secret, updated_at) VALUES (?, ?, NULL, ?)", [pubkey, hash, now]);
    }
  }

  async setTotp(pubkey: string, secret: string | null): Promise<void> {
    await this.db.run("UPDATE admin_credentials SET totp_secret = ?, updated_at = ? WHERE pubkey = ?", [secret, this.nowSec(), pubkey]);
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
}
