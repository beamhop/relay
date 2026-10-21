// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin actions for updates, rollback, doctor and the resource advisor (§14, §6.7, §6.11). */
import {
  type ActionDef,
  type BeamhopConfig,
  type DiffLine,
  type Kernel,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import {
  CONFIG_ADVICE,
  type ConfigAdviceId,
  configAdviceValue,
  gatherFacts,
  runAdvisor,
} from './advisor.ts';
import { runDoctorReport } from './doctor.ts';
import type { UpdateManager } from './update.ts';

const UNDO_SECONDS = 15 * 60;

interface ConfigApplier {
  apply?(
    next: unknown,
    opts: { principalId: string; summary?: string; reason?: string },
  ): Promise<unknown>;
}

export function createSystemActions(kernel: Kernel, updates: UpdateManager): ActionDef[] {
  const now = () => kernel.ports.clock.now();

  const check = defineAction({
    id: 'system.update-check',
    title: 'Check for updates',
    description: 'See which version runs now, whether a newer one is out and what changed.',
    technical:
      'Release manifest (modules.updates.manifestUrl / BEAMHOP_UPDATE_MANIFEST) → version compare; minisign key from modules.updates.publicKey / BEAMHOP_UPDATE_PUBLIC_KEY; install kind decides self-update.',
    scope: 'node',
    permission: 'node.manage',
    readOnly: true,
    keywords: ['update', 'upgrade', 'version', 'release'],
    input: z.object({}),
    async run() {
      const out = await updates.check();
      return {
        output: out,
        summary: out.updateAvailable
          ? `Version ${out.latest} is available (you have ${out.current})`
          : out.latest
            ? `You have the latest version (${out.current})`
            : (out.blocked ?? `Version ${out.current}`),
      };
    },
  });

  const update = defineAction({
    id: 'system.update',
    title: 'Update Beamhop',
    description:
      'Back up, install the newest version and restart. If it is not healthy, Beamhop goes back by itself.',
    technical:
      'backups.run-now → download → SHA-256 + minisign → --version smoke test → atomic rename (previous kept) → restart → health self-test → automatic rollback on new critical health checks.',
    scope: 'node',
    permission: 'node.manage',
    sensitive: true,
    keywords: ['update', 'upgrade', 'install', 'release'],
    input: z.object({
      version: z
        .string()
        .optional()
        .describe('The version you saw (refuses if a newer one appeared)'),
      skipBackup: z.boolean().default(false).describe('Do not back up first (not recommended)'),
    }),
    preview: (input) => updates.previewSteps(input),
    async run(input) {
      const state = await updates.start(input);
      return {
        output: state,
        summary: `Updating to ${state.to}…`,
        undo: {
          actionId: 'system.update',
          payload: { to: state.to },
          expiresAt: now() + 24 * 3600,
        },
      };
    },
    async undo() {
      await updates.rollback({ restoreBackup: false });
    },
  });

  const status = defineAction({
    id: 'system.update-status',
    title: 'Update progress',
    description: 'Where a running update is, and whether you can go back to the previous version.',
    technical: 'DocStore system.update/state (survives the restart) + live download progress.',
    scope: 'node',
    permission: 'node.manage',
    readOnly: true,
    input: z.object({}),
    async run() {
      const s = await updates.status();
      return { output: s, summary: s.message };
    },
  });

  const rollback = defineAction({
    id: 'system.rollback',
    title: 'Go back to the previous version',
    description:
      'Put the version from before the last update back. Optionally restore the backup made before it.',
    technical:
      'Swap <bin>.previous → <bin> (current kept as <bin>.rolled-back), optional backups.restore of the pre-update backup, restart.',
    scope: 'node',
    permission: 'node.manage',
    sensitive: true,
    keywords: ['rollback', 'downgrade', 'undo update', 'previous version'],
    input: z.object({
      restoreBackup: z
        .boolean()
        .default(false)
        .describe('Also restore the data from before the update (newer changes are lost)'),
    }),
    preview: (input) => updates.rollbackPreview(input),
    async run(input) {
      const r = await updates.rollback(input);
      return {
        output: r,
        summary: `Going back to ${r.version}${r.restored ? ' with the data from before the update' : ''}…`,
      };
    },
  });

  const doctor = defineAction({
    id: 'system.doctor',
    title: 'Check this setup',
    description:
      'Check DNS, certificate, ports, proxy, WebSocket, disk, clock, storage and every health check.',
    technical:
      'runtime.doctor (beamhop doctor checks: config.*, data.*, disk.free, storage.*, dns.*, tls.*, port.listen, proxy.*, clock.skew) + kernel.health checks; fixes are action ids, never auto-applied.',
    scope: 'node',
    permission: 'config.write',
    readOnly: true,
    keywords: ['doctor', 'diagnose', 'health', 'dns', 'certificate', 'proxy'],
    input: z.object({}),
    async run() {
      const r = await runDoctorReport(kernel);
      const bad = r.counts.red + r.counts.amber;
      return {
        output: r,
        summary: bad
          ? `${r.counts.red} problem(s), ${r.counts.amber} warning(s)`
          : 'All checks passed',
      };
    },
  });

  const advisor = defineAction({
    id: 'system.advisor',
    title: 'Resource advice',
    description: 'Machine size and settings that fit your traffic and storage.',
    technical:
      'insights live (connections, ev/s, storage.bytes), disk.free 7-day trend, media bytes (blob store scan, ≤20k files), runtime.host (cores, memory, node.verifyWorkers).',
    scope: 'node',
    permission: 'config.write',
    readOnly: true,
    keywords: ['advisor', 'machine', 'size', 'cost', 'cpu', 'memory', 'disk'],
    input: z.object({}),
    async run() {
      const r = await runAdvisor(kernel);
      return { output: r, summary: r.advice[0]?.title ?? 'No advice' };
    },
  });

  const applyInput = z.object({ id: z.enum(CONFIG_ADVICE).describe('Advice to apply') });
  const diffFor = (prev: number | undefined, next: number): DiffLine => ({
    kind: 'change',
    text:
      next === 0
        ? 'Check signatures on the main thread (after the next restart)'
        : `Check signatures on ${next} extra threads (after the next restart)`,
    technical: `node.verifyWorkers: ${prev ?? 'auto'} → ${next}`,
  });
  const applyAdvice = defineAction({
    id: 'system.apply-advice',
    title: 'Apply resource advice',
    description: 'Make the settings change a resource suggestion recommends.',
    technical: 'Patches node.verifyWorkers via admin.config (revisioned, undoable).',
    scope: 'node',
    permission: 'node.manage',
    input: applyInput,
    async preview(input) {
      const next = configAdviceValue(input.id as ConfigAdviceId, await gatherFacts(kernel));
      if (next === null) return [{ kind: 'info', text: 'This suggestion no longer applies' }];
      return [diffFor(kernel.config().node.verifyWorkers, next)];
    },
    async run(input, ctx) {
      const next = configAdviceValue(input.id as ConfigAdviceId, await gatherFacts(kernel));
      if (next === null) throw new Error('This suggestion no longer applies.');
      const cfg = kernel.config();
      const prev = cfg.node.verifyWorkers;
      const svc = kernel.use<ConfigApplier>('admin.config');
      if (!svc?.apply) throw new Error('Settings cannot be changed here.');
      const nextConfig: BeamhopConfig = { ...cfg, node: { ...cfg.node, verifyWorkers: next } };
      const summary =
        next === 0
          ? 'Signatures checked on the main thread'
          : `Signatures checked on ${next} threads`;
      await svc.apply(nextConfig, { principalId: ctx.principal.id, summary, reason: ctx.reason });
      return {
        output: { diff: [diffFor(prev, next)], restartNeeded: true },
        summary: `${summary} after the next restart`,
        undo: {
          actionId: 'system.apply-advice',
          payload: { prev: prev ?? null },
          expiresAt: now() + UNDO_SECONDS,
        },
      };
    },
    async undo(payload, ctx) {
      const svc = kernel.use<ConfigApplier>('admin.config');
      if (!svc?.apply) throw new Error('config service unavailable');
      const cfg = kernel.config();
      const prev = (payload as { prev: number | null }).prev;
      const { verifyWorkers: _drop, ...rest } = cfg.node;
      const node: BeamhopConfig['node'] = prev === null ? rest : { ...rest, verifyWorkers: prev };
      await svc.apply(
        { ...cfg, node },
        { principalId: ctx.principal.id, summary: 'Undo resource advice' },
      );
    },
  });

  return [check, update, status, rollback, doctor, advisor, applyAdvice] as ActionDef[];
}
