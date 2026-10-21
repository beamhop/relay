// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BeamhopConfig, type Kernel, parseConfig } from '@beamhop/core';

interface ConfigServiceLike {
  apply?(
    next: unknown,
    opts: { principalId: string; summary?: string; reason?: string },
  ): Promise<unknown>;
}

/**
 * Commit a config change through the admin config service when present
 * (revision history, audit, undo), else straight to the kernel.
 */
export async function commitConfig(
  kernel: Kernel,
  mutate: (c: BeamhopConfig) => BeamhopConfig,
  opts: { principalId: string; summary: string; reason?: string },
): Promise<void> {
  const next = mutate(structuredClone(kernel.config()));
  const svc = kernel.use<ConfigServiceLike>('admin.config');
  if (svc?.apply) await svc.apply(next, opts);
  else await kernel.applyConfig(parseConfig(next));
}
