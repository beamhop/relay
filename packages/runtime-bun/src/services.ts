// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loose views of services other modules provide through `kernel.provide()`.
 * The runtime uses them only if present, and tolerates several method names
 * because the providers are built in parallel.
 */
import type { BeamhopConfig, Kernel } from '@beamhop/core';

export interface ClaimCode {
  code: string;
  /** Full claim URL if the provider builds one. */
  url?: string;
  expiresAt?: number;
}

/** `kernel.use('admin.claim')` */
export interface ClaimServiceLike {
  isClaimed?(): boolean | Promise<boolean>;
  issueCode?(): unknown;
  createCode?(): unknown;
  createClaimCode?(): unknown;
  getOrCreateCode?(): unknown;
  ensureCode?(): unknown;
}

/** `kernel.use('admin.config')` */
export interface ConfigServiceLike {
  /** Last config revision that booted healthy (safe mode). */
  lastKnownGood?(): Promise<BeamhopConfig | null | undefined> | BeamhopConfig | null | undefined;
  getLastKnownGood?(): Promise<BeamhopConfig | null | undefined> | BeamhopConfig | null | undefined;
  /** Record the boot file as a new revision ("file wins on boot"). */
  adoptBootConfig?(config: BeamhopConfig, meta: { source: 'file'; path: string }): unknown;
  /** Mark the running config as known-good after a healthy boot. */
  markKnownGood?(config: BeamhopConfig): unknown;
}

function normalizeCode(v: unknown): ClaimCode | null {
  if (!v) return null;
  if (typeof v === 'string') return { code: v };
  if (typeof v === 'object' && typeof (v as ClaimCode).code === 'string') return v as ClaimCode;
  return null;
}

/** Ask the claim service for a one-time code (null if already claimed or no service). */
export async function obtainClaimCode(kernel: Kernel): Promise<ClaimCode | null> {
  const svc = kernel.use<ClaimServiceLike>('admin.claim');
  if (!svc) return null;
  if (svc.isClaimed && (await svc.isClaimed())) return null;
  const fn =
    svc.issueCode ?? svc.getOrCreateCode ?? svc.ensureCode ?? svc.createClaimCode ?? svc.createCode;
  if (!fn) return null;
  return normalizeCode(await fn.call(svc));
}

export async function lastKnownGood(kernel: Kernel): Promise<BeamhopConfig | null> {
  const svc = kernel.use<ConfigServiceLike>('admin.config');
  const fn = svc?.lastKnownGood ?? svc?.getLastKnownGood;
  if (!svc || !fn) return null;
  return (await fn.call(svc)) ?? null;
}
