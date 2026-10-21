// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loose view of `kernel.use('enterprise.identity')` (enterprise-identity module).
 * Every method is optional: compliance works without a directory and uses what is there.
 */
import type { Kernel } from '@beamhop/core';

export interface IdentityLike {
  /** IdP group ids/names of the person bound to this pubkey. */
  groupsOf?(pubkey: string): Promise<string[]> | string[];
  /** Pubkey bound to a directory subject (`idp` optional). */
  pubkeyOf?(subject: string, idp?: string): Promise<string | null> | string | null;
  /** Every bound person with their groups (usage reports). */
  members?(): Promise<Array<{ pubkey: string; groups: string[] }>>;
}

export function identityOf(kernel: Kernel): IdentityLike | undefined {
  return kernel.use<IdentityLike>('enterprise.identity');
}

export async function groupsOf(kernel: Kernel, pubkey: string): Promise<string[]> {
  const id = identityOf(kernel);
  if (!id?.groupsOf) return [];
  try {
    return (await id.groupsOf(pubkey)) ?? [];
  } catch {
    return [];
  }
}
