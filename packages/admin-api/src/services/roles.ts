import { ROLE_PERMISSIONS, type AdminRole, type Permission, type UserStore } from "@beamhop/sdk";

export const ROLE_RANK: Record<AdminRole, number> = { owner: 4, admin: 3, moderator: 2, viewer: 1 };

const EMPTY: ReadonlySet<Permission> = new Set();
const PERM_SETS = Object.fromEntries(
  Object.entries(ROLE_PERMISSIONS).map(([r, perms]) => [r, new Set(perms)]),
) as unknown as Record<AdminRole, ReadonlySet<Permission>>;

export const permissionsFor = (role: AdminRole | null): ReadonlySet<Permission> => (role ? PERM_SETS[role] : EMPTY);

export class RoleService {
  readonly owners: ReadonlySet<string>;
  constructor(
    private readonly users: UserStore,
    owners: string[],
  ) {
    this.owners = new Set(owners.map((o) => o.toLowerCase()));
  }
  isConfigOwner(pubkey: string) {
    return this.owners.has(pubkey);
  }
  async resolve(pubkey: string): Promise<AdminRole | null> {
    if (this.owners.has(pubkey)) return "owner";
    return (await this.users.get(pubkey))?.role ?? null;
  }
  /** Effective role for display (config owners are always owner). */
  effective(pubkey: string, stored: AdminRole | null): AdminRole | null {
    return this.owners.has(pubkey) ? "owner" : stored;
  }
}
