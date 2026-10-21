// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mock actions of Settings → Backups and restore (lifecycle module, vanilla)
 * and of `plugins.grant-permissions` (the plugin writer's "Allow" button).
 * State lives per mock-server state object, so `/__reset` starts fresh.
 *
 * Backups: two catalogued backups (the newest not checked yet), one archive
 * found in storage. "Back up now" adds one; "Check" marks it checked;
 * Restore previews what changes and then reports success.
 */
import { z } from 'zod';

type Diff = {
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
  text: string;
  technical?: string;
};

interface MockAction {
  id: string;
  title: string;
  description: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly?: boolean;
  keywords?: string[];
  input: z.ZodType;
  preview?: (input: Record<string, unknown>) => Diff[];
  run: (input: Record<string, unknown>) => { output: unknown; summary: string; undo?: () => void };
}

const now = () => Math.floor(Date.now() / 1000);
const MB = 1024 * 1024;

interface Backup {
  id: string;
  at: number;
  ok: true;
  trigger: 'scheduled' | 'manual';
  sha256: string;
  size: number;
  location: string;
  dbFormat: string;
  driver: string;
  events: number;
  blobs: number;
  durationMs: number;
  verifiedAt?: number;
  verifiedOk?: boolean;
}

interface BackupsState {
  backups: Backup[];
  restored: string[];
  approved: Record<string, string[]>;
  seq: number;
}

/** `/ui` route the lifecycle module declares (packages/lifecycle/src/index.ts). */
export const BACKUPS_ROUTE = {
  path: '/settings/backups',
  title: 'Backups and restore',
  placement: 'settings-section',
  chunk: 'lifecycle-backups',
} as const;

/** The lifecycle module is part of every profile: put its route first in a `/ui` body. */
export function withBackupsRoute<T extends { routes: unknown[] }>(body: T): T {
  return { ...body, routes: [BACKUPS_ROUTE, ...body.routes] };
}

const backup = (n: number, at: number, o: Partial<Backup> = {}): Backup => ({
  id: `b-${String(at).padStart(10, '0')}-${n}`,
  at,
  ok: true,
  trigger: 'scheduled',
  sha256: String(n).repeat(64).slice(0, 64),
  size: (40 + n) * MB,
  location: `fs:data/backups/${n}`,
  dbFormat: 'sqlite',
  driver: 'sqlite',
  events: 12_000 + n,
  blobs: 300,
  durationMs: 900,
  ...o,
});

const fresh = (): BackupsState => ({
  backups: [
    backup(1, now() - 2 * 86_400, { verifiedAt: now() - 86_400, verifiedOk: true }),
    backup(2, now() - 3 * 3600),
  ],
  restored: [],
  approved: {},
  seq: 3,
});

const states = new WeakMap<object, BackupsState>();

const PERMISSION_TEXT: Record<string, string> = {
  'read-events': 'Read posts and profiles stored on this relay',
  'write-events': 'Publish new events to this relay on its own',
  network: 'Connect to other websites and servers on the internet',
  docs: 'Keep its own saved data on this server',
};

function mocks(st: () => BackupsState): MockAction[] {
  return [
    {
      id: 'backups.list',
      title: 'Backups',
      description: 'See your backups and when the last one ran.',
      scope: 'node',
      permission: 'node.manage',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = st();
        const newest = [...s.backups].sort((a, b) => b.at - a.at)[0];
        return {
          output: {
            backups: s.backups,
            unknownArchives: [{ sha256: 'e'.repeat(64), size: 30 * MB }],
            last: newest ? { at: newest.at, ok: true, size: newest.size, id: newest.id } : null,
            target: 'fs:data/backups',
            schedule: { enabled: true, schedule: 'daily', keep: 14 },
            running: false,
            standby: { enabled: false },
          },
          summary: `${s.backups.length} backups`,
        };
      },
    },
    {
      id: 'backups.run-now',
      title: 'Back up now',
      description: 'Make a backup right away.',
      scope: 'node',
      permission: 'node.manage',
      input: z.object({}),
      preview: () => [{ kind: 'add', text: 'Make a new backup' }],
      run: () => {
        const s = st();
        const b = backup(s.seq++, now(), { trigger: 'manual', size: 45 * MB });
        s.backups.push(b);
        return { output: b, summary: 'Backup made (45.0 MB)' };
      },
    },
    {
      id: 'backups.verify',
      title: 'Check a backup',
      description: 'Make sure a backup is complete and undamaged.',
      scope: 'node',
      permission: 'node.manage',
      readOnly: true,
      input: z.object({ id: z.string().min(1) }),
      run: (i) => {
        const b = st().backups.find((x) => x.id === i.id);
        if (b) {
          b.verifiedAt = now();
          b.verifiedOk = true;
        }
        return {
          output: { ok: !!b, problems: b ? [] : ['No backup called that'] },
          summary: b ? 'Backup is complete and undamaged' : 'Backup has problems',
        };
      },
    },
    {
      id: 'backups.restore',
      title: 'Restore a backup',
      description: 'Put everything back the way it was when the backup was made.',
      scope: 'node',
      permission: 'node.manage',
      input: z.object({ id: z.string().min(1), blobs: z.boolean().default(true) }),
      preview: (i) => {
        const b = st().backups.find((x) => x.id === i.id || x.sha256 === i.id);
        const when = new Date((b?.at ?? now()) * 1000).toISOString().slice(0, 16).replace('T', ' ');
        return [
          {
            kind: 'warning',
            text: `Everything will go back to how it was on ${when} UTC. Changes made since then are lost.`,
            technical: `restore ${String(i.id)}`,
          },
          { kind: 'info', text: 'New posts and uploads are paused while the backup is restored.' },
          {
            kind: 'change',
            text: `Main: 12500 posts now → ${b?.events ?? 0} posts from the backup`,
          },
        ];
      },
      run: (i) => {
        st().restored.push(String(i.id));
        return {
          output: { ok: true, id: i.id },
          summary: 'Backup restored (12002 posts, 0 media files copied back)',
        };
      },
    },
    {
      id: 'backups.litestream-config',
      title: 'Standby server setup file',
      description: 'Get the Litestream settings file for a standby server.',
      scope: 'node',
      permission: 'node.manage',
      readOnly: true,
      input: z.object({ inlineSecrets: z.boolean().default(false) }),
      run: () => ({
        output: { filename: 'litestream.yml', yaml: 'dbs:\n  - path: data/beamhop.db\n' },
        summary: 'Litestream settings ready',
      }),
    },
    {
      id: 'retention.run-now',
      title: 'Clean up old posts now',
      description: 'Remove posts that are older than your keep-for rules right away.',
      scope: 'relay',
      permission: 'config.write',
      input: z.object({}),
      preview: () => [{ kind: 'info', text: 'Posts are kept forever; nothing to remove' }],
      run: () => ({ output: { deleted: 0, complete: true }, summary: 'No old posts to remove' }),
    },
    {
      id: 'plugins.grant-permissions',
      title: 'Allow a plugin more access',
      description: 'Let a plugin read your data, save its own data or go online.',
      scope: 'node',
      permission: 'node.manage',
      input: z.object({ id: z.string().min(1), permissions: z.array(z.string()).min(1) }),
      preview: (i) => [
        ...(i.permissions as string[]).map(
          (p): Diff => ({
            kind: p === 'network' || p === 'write-events' ? 'warning' : 'add',
            text: `“${String(i.id)}” will be able to: ${(PERMISSION_TEXT[p] ?? p).toLowerCase()}`,
            technical: `modules.plugins.entries.${String(i.id)}.approvedPermissions += ${p}`,
          }),
        ),
        { kind: 'info', text: 'Only allow this if you trust what the plugin does' },
      ],
      run: (i) => {
        const s = st();
        const id = String(i.id);
        const prev = s.approved[id];
        s.approved[id] = [...new Set([...(prev ?? []), ...(i.permissions as string[])])];
        return {
          output: { id, approvedPermissions: s.approved[id] },
          summary: 'Allowed the plugin the access it asked for',
          undo: () => {
            if (prev) s.approved[id] = prev;
            else delete s.approved[id];
          },
        };
      },
    },
  ];
}

/** Register (or replace) the backups + plugin-access mocks on the server's action list. */
export function registerBackupsMocks(actions: Array<{ id: string }>, current: () => object): void {
  const st = (): BackupsState => {
    const key = current();
    let s = states.get(key);
    if (!s) {
      s = fresh();
      states.set(key, s);
    }
    return s;
  };
  for (const a of mocks(st)) {
    const i = actions.findIndex((x) => x.id === a.id);
    if (i >= 0) actions.splice(i, 1, a);
    else actions.push(a);
  }
}
