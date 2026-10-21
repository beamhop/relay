// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin actions (§6.13): backups, retention, storage pruning, user export. */
import {
  type ActionContext,
  type ActionDef,
  type BeamhopConfig,
  BlobStorageSchema,
  type DiffLine,
  type RelayId,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import type { BackupService } from './backup.ts';
import { exportUserData } from './export.ts';
import {
  type LitestreamMonitor,
  generateLitestreamConfig,
  litestreamHealth,
} from './litestream.ts';
import type { RetentionEngine } from './retention.ts';
import type { LifecycleRuntime } from './runtime.ts';
import { readAll } from './tar.ts';

const UNDO_SECONDS = 15 * 60;
const HEX64 = /^[0-9a-f]{64}$/;

interface ConfigApplier {
  apply?(
    next: unknown,
    opts: { principalId: string; summary?: string; reason?: string },
  ): Promise<unknown>;
}

function needRelay(ctx: ActionContext): RelayId {
  if (!ctx.relayId) throw new Error('choose a relay first');
  return ctx.relayId;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type BackupsSection = BeamhopConfig['backups'];

function describeTarget(t: BackupsSection['target']): string {
  if (!t || (t.driver === 'fs' && !t.path)) return 'this server (data/backups)';
  if (t.driver === 'fs') return `the folder ${t.path}`;
  return `${t.driver.toUpperCase()} bucket ${t.bucket ?? '(not set)'}`;
}

export function backupsDiff(prev: BackupsSection, next: BackupsSection): DiffLine[] {
  const lines: DiffLine[] = [];
  if (prev.enabled !== next.enabled)
    lines.push({
      kind: next.enabled ? 'add' : 'remove',
      text: next.enabled ? 'Turn on automatic backups' : 'Turn off automatic backups',
      technical: `backups.enabled: ${prev.enabled} → ${next.enabled}`,
    });
  if (prev.schedule !== next.schedule)
    lines.push({
      kind: 'change',
      text: `Back up ${next.schedule} (was ${prev.schedule})`,
      technical: `backups.schedule: ${prev.schedule} → ${next.schedule}`,
    });
  if (prev.keep !== next.keep)
    lines.push({
      kind: 'change',
      text: `Keep the last ${next.keep} backups (was ${prev.keep})`,
      technical: `backups.keep: ${prev.keep} → ${next.keep}`,
    });
  if (JSON.stringify(prev.target ?? null) !== JSON.stringify(next.target ?? null))
    lines.push({
      kind: 'change',
      text: `Store backups in ${describeTarget(next.target)}`,
      technical: `backups.target.driver: ${prev.target?.driver ?? 'default'} → ${next.target?.driver ?? 'default'}`,
    });
  return lines;
}

export function createActions(
  rt: LifecycleRuntime,
  backups: BackupService,
  retention: RetentionEngine,
  litestreamMonitor?: LitestreamMonitor,
): ActionDef[] {
  const now = () => rt.ports.clock.now();

  const runNow = defineAction({
    id: 'backups.run-now',
    title: 'Back up now',
    description: 'Make a backup of posts, media lists and settings right away.',
    technical:
      'SQLite VACUUM INTO / logical NDJSON table dump + blob manifest + config revision → tar.gz in the backup target.',
    scope: 'node',
    permission: 'node.manage',
    keywords: ['backup', 'snapshot', 'export'],
    input: z.object({}),
    async preview() {
      const uri = backups.targetUri();
      if (!uri) return [{ kind: 'warning', text: 'No backup storage is configured yet' }];
      return [
        { kind: 'add', text: 'Make a new backup', technical: `target ${uri}` },
        {
          kind: 'info',
          text: `Older backups beyond the newest ${rt.kernel.config().backups.keep} are removed`,
        },
      ];
    },
    async run() {
      const last = await backups.run('manual');
      if (!last.ok) throw new Error(`Backup failed: ${last.error}`);
      return {
        output: last,
        summary: `Backup made (${size(last.size ?? 0)})`,
      };
    },
  });

  const list = defineAction({
    id: 'backups.list',
    title: 'Backups',
    description: 'See your backups and when the last one ran.',
    technical: 'DocStore lifecycle.backups (b-* catalog, last) + archives found in the target.',
    scope: 'node',
    permission: 'node.manage',
    readOnly: true,
    input: z.object({}),
    async run() {
      const [l, last] = await Promise.all([backups.list(), backups.last()]);
      const ls = rt.settings().litestream;
      const health =
        ls.enabled && litestreamMonitor ? litestreamHealth(litestreamMonitor.status, ls) : null;
      return {
        output: {
          ...l,
          last,
          target: backups.targetUri(),
          schedule: (({ enabled, schedule, keep }) => ({ enabled, schedule, keep }))(
            rt.kernel.config().backups,
          ),
          running: backups.inProgress(),
          standby: {
            enabled: ls.enabled,
            ...(health
              ? { status: health.status, message: health.message, technical: health.technical }
              : {}),
          },
        },
        summary: `${l.backups.length} backups`,
      };
    },
  });

  const verify = defineAction({
    id: 'backups.verify',
    title: 'Check a backup',
    description: 'Make sure a backup is complete and undamaged.',
    technical: 'Archive sha256 vs catalog, then sha256 of every file vs manifest.json.',
    scope: 'node',
    permission: 'node.manage',
    readOnly: true,
    input: z.object({ id: z.string().min(1) }),
    async run(input) {
      const r = await backups.verify(input.id);
      return {
        output: { ok: r.ok, problems: r.problems, manifest: r.manifest },
        summary: r.ok
          ? 'Backup is complete and undamaged'
          : `Backup has problems: ${r.problems[0]}`,
      };
    },
  });

  const restore = defineAction({
    id: 'backups.restore',
    title: 'Restore a backup',
    description: 'Put everything back the way it was when the backup was made.',
    technical:
      'Verify hashes → pause writes (policy hook) → replace tables (tags/FTS rebuilt by triggers) → verify row counts → copy missing blob bytes from the target.',
    scope: 'node',
    permission: 'node.manage',
    sensitive: true,
    keywords: ['restore', 'rollback', 'disaster'],
    input: z.object({
      id: z.string().min(1).describe('Backup id (or archive sha256)'),
      blobs: z.boolean().default(true).describe('Copy missing media files back'),
    }),
    preview: (input) => backups.restorePreview(input.id),
    async run(input) {
      const r = await backups.restore(input.id, { blobs: input.blobs });
      const events = Object.values(r.events).reduce((a, b) => a + b, 0);
      return {
        output: r,
        summary: r.ok
          ? `Backup restored (${events} posts, ${r.blobs.restored} media files copied back)`
          : `Backup restored with problems: ${r.problems.join('; ')}`,
      };
    },
  });

  const setupInput = z.object({
    enabled: z.boolean().default(true),
    schedule: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
    keep: z.number().int().positive().default(14),
    target: BlobStorageSchema.optional(),
  });
  const nextBackups = (input: z.infer<typeof setupInput>): BackupsSection => {
    const prev = rt.kernel.config().backups;
    return {
      ...prev,
      enabled: input.enabled,
      schedule: input.schedule,
      keep: input.keep,
      ...(input.target ? { target: input.target } : {}),
    };
  };
  const setup = defineAction({
    id: 'backups.setup',
    title: 'Set up backups',
    description: 'Choose how often to back up, how many backups to keep and where they go.',
    technical: 'Patches config.backups via admin.config (revisioned, undoable).',
    scope: 'node',
    permission: 'node.manage',
    keywords: ['backup', 'schedule', 's3', 'r2'],
    input: setupInput,
    async preview(input) {
      const prev = rt.kernel.config().backups;
      const lines = backupsDiff(prev, nextBackups(input));
      if (!lines.length) return [{ kind: 'info', text: 'Backups are already set up like this' }];
      return lines;
    },
    async run(input, ctx) {
      const cfg = rt.kernel.config();
      const prev = cfg.backups;
      const next = nextBackups(input);
      const diff = backupsDiff(prev, next);
      const nextConfig: BeamhopConfig = { ...cfg, backups: next };
      const svc = rt.kernel.use<ConfigApplier>('admin.config');
      const summary = next.enabled
        ? `Backups turned on (${next.schedule}, keep ${next.keep})`
        : 'Backups turned off';
      let committed = false;
      if (svc?.apply && diff.length) {
        await svc.apply(nextConfig, { principalId: ctx.principal.id, summary, reason: ctx.reason });
        committed = true;
      }
      return {
        output: { patch: { backups: next }, diff, committed },
        summary: committed ? summary : `${summary} (not saved yet: apply the patch)`,
        ...(committed
          ? {
              undo: {
                actionId: 'backups.setup',
                payload: { prev },
                expiresAt: now() + UNDO_SECONDS,
              },
            }
          : {}),
      };
    },
    async undo(payload, ctx) {
      const svc = rt.kernel.use<ConfigApplier>('admin.config');
      if (!svc?.apply) throw new Error('config service unavailable');
      const cfg = rt.kernel.config();
      await svc.apply(
        { ...cfg, backups: (payload as { prev: BackupsSection }).prev },
        { principalId: ctx.principal.id, summary: 'Undo backup settings change' },
      );
    },
  });

  const litestream = defineAction({
    id: 'backups.litestream-config',
    title: 'Standby server setup file',
    description:
      'Get the Litestream settings file for a standby server that takes over if this one fails.',
    technical: 'generateLitestreamConfig(config): litestream.yml with S3/GCS/R2/file replica.',
    scope: 'node',
    permission: 'node.manage',
    readOnly: true,
    keywords: ['litestream', 'replication', 'failover', 'high availability'],
    input: z.object({ inlineSecrets: z.boolean().default(false) }),
    async run(input) {
      const yaml = generateLitestreamConfig(rt.kernel.config(), {
        inlineSecrets: input.inlineSecrets,
      });
      return { output: { filename: 'litestream.yml', yaml }, summary: 'Litestream settings ready' };
    },
  });

  const retentionRun = defineAction({
    id: 'retention.run-now',
    title: 'Clean up old posts now',
    description: 'Remove posts that are older than your keep-for rules right away.',
    technical:
      'Chunked sweep: per-kind rules, then tier retentionDays / relay-wide rule / goals defaultRetentionDays on regular kinds; legal holds respected.',
    scope: 'relay',
    permission: 'config.write',
    input: z.object({}),
    async preview(_input, ctx) {
      const relay = rt.kernel.relay(needRelay(ctx));
      if (!relay) return [{ kind: 'warning', text: 'Unknown relay' }];
      const plan = retention.plan(relay);
      const lines: DiffLine[] = plan.kindRules.map((g) => ({
        kind: 'remove',
        text: `Remove posts of kinds ${g.kinds.join(', ')} older than ${g.days} days`,
        technical: `deleteByIds(kinds=[${g.kinds.join(',')}], created_at <= now-${g.days}d)`,
      }));
      for (const [tier, days] of Object.entries(plan.tierDays))
        lines.push({ kind: 'remove', text: `Tier ${tier}: remove posts older than ${days} days` });
      const fallback = plan.genericDays ?? plan.goalDays;
      if (fallback !== undefined)
        lines.push({
          kind: 'remove',
          text: `Everyone else: remove posts older than ${fallback} days`,
        });
      if (!lines.length)
        return [{ kind: 'info', text: 'Posts are kept forever; nothing to remove' }];
      lines.push({
        kind: 'warning',
        text: 'Removed posts cannot be restored except from a backup',
      });
      return lines;
    },
    async run(_input, ctx) {
      const relay = rt.kernel.relay(needRelay(ctx));
      if (!relay) throw new Error('Unknown relay');
      const r = await retention.runRelay(relay);
      return {
        output: r,
        summary: r.deleted
          ? `Removed ${r.deleted} old posts${r.complete ? '' : ' (more next run)'}`
          : 'No old posts to remove',
      };
    },
  });

  const prune = defineAction({
    id: 'lifecycle.prune-storage',
    title: 'Free up space',
    description: 'Remove the oldest reactions and reposts until storage is back under its limit.',
    technical:
      'Oldest-first day windows over storageCaps[relay].lowValueKinds until targetPercent of maxBytes; legal holds respected.',
    scope: 'relay',
    permission: 'config.write',
    sensitive: true,
    keywords: ['storage', 'disk', 'prune', 'space'],
    input: z.object({}),
    async preview(_input, ctx) {
      const relayId = needRelay(ctx);
      const cap = retention.capFor(relayId);
      if (!cap) return [{ kind: 'info', text: 'No storage limit is set for this relay' }];
      const est = await retention.pruneEstimate(relayId);
      if (est.needBytes <= 0) return [{ kind: 'info', text: 'Storage is already under its limit' }];
      return [
        {
          kind: 'remove',
          text: `Remove the oldest reactions and reposts to free about ${size(est.needBytes)} (${est.candidates} candidates)`,
          technical: `kinds ${cap.lowValueKinds.join(',')} oldest-first → ${cap.targetPercent}% of ${cap.maxBytes} bytes`,
        },
        { kind: 'warning', text: 'Removed posts cannot be restored except from a backup' },
      ];
    },
    async run(_input, ctx) {
      const relayId = needRelay(ctx);
      const r = await retention.prune(relayId);
      return {
        output: r,
        summary: r.deleted
          ? `Removed ${r.deleted} old reactions and reposts (${size(r.freedBytes)})`
          : 'Nothing to remove',
      };
    },
  });

  const exportUser = defineAction({
    id: 'lifecycle.export-user',
    title: 'Download a person’s data',
    description: 'Everything one person posted here, plus their media list, as a file.',
    technical:
      'NDJSON: header, {type:"event"} per authored event, {type:"blob"} per owned blob, end.',
    scope: 'relay',
    permission: 'users.write',
    readOnly: true,
    keywords: ['export', 'gdpr', 'takeout', 'download'],
    input: z.object({
      pubkey: z.string().regex(HEX64, 'expected a 64-character hex public key'),
      maxEvents: z.number().int().positive().max(1_000_000).default(100_000),
    }),
    async run(input, ctx) {
      const relayId = needRelay(ctx);
      const stream = exportUserData(rt.ports, relayId, input.pubkey, {
        maxEvents: input.maxEvents,
      });
      const ndjson = new TextDecoder().decode(await readAll(stream));
      const end = JSON.parse(ndjson.trimEnd().split('\n').pop() ?? '{}') as {
        events?: number;
        blobs?: number;
        truncated?: boolean;
      };
      return {
        output: {
          filename: `beamhop-export-${relayId}-${input.pubkey.slice(0, 12)}.ndjson`,
          contentType: 'application/x-ndjson',
          events: end.events ?? 0,
          blobs: end.blobs ?? 0,
          truncated: end.truncated ?? false,
          ndjson,
        },
        summary: `Exported ${end.events ?? 0} posts and ${end.blobs ?? 0} media files`,
      };
    },
  });

  return [
    runNow,
    list,
    verify,
    restore,
    setup,
    litestream,
    retentionRun,
    prune,
    exportUser,
  ] as unknown as ActionDef[];
}
