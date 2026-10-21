// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mocks the top-20 tasks E2E (`e2e/top-tasks*.e2e.ts`) needs and no other mock
 * provides: "Back up now", deleting one file, and restoring an older settings
 * revision (its diff + restore routes). `POST /__reset {topTasks: true}` also
 * seeds a second settings revision so there is something to restore.
 * Actions are only added when no other mock defines the same id.
 */
import type { Hono } from 'hono';
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

interface Revision {
  revision: number;
  at: number;
  author: string;
  authorName: string;
  summary: string;
  source: string;
  changes: number;
}

export interface TopTasksHost {
  app: Hono;
  actions: MockAction[];
  state: () => {
    revision: number;
    revisions: Revision[];
    log: Array<{ id: string; input: unknown }>;
    undo: Map<string, () => void>;
  };
  token: () => string;
}

const now = () => Math.floor(Date.now() / 1000);
const OWNER = 'a'.repeat(64);

function actions(): MockAction[] {
  return [
    {
      id: 'backups.run-now',
      title: 'Back up now',
      description: 'Make a backup of posts, media lists and settings right away.',
      scope: 'node',
      permission: 'node.manage',
      keywords: ['backup', 'snapshot', 'export'],
      input: z.object({}),
      preview: () => [
        { kind: 'add', text: 'Make a new backup', technical: 'target s3://backups/beamhop' },
        { kind: 'info', text: 'Older backups beyond the newest 7 are removed' },
      ],
      run: () => ({ output: { ok: true, size: 12_582_912 }, summary: 'Backup made (12 MB)' }),
    },
    {
      id: 'media.delete-blob',
      title: 'Delete a file',
      description: 'Remove one uploaded file.',
      scope: 'relay',
      permission: 'media.write',
      input: z.object({ sha256: z.string(), pubkey: z.string().optional() }),
      preview: () => [{ kind: 'remove', text: '1 file will be deleted' }],
      run: () => ({ output: { deleted: 1 }, summary: 'Deleted 1 file', undo: () => {} }),
    },
  ];
}

/** Register the top-tasks mocks: missing actions, a seeded revision and the restore routes. */
export function registerTopTaskMocks(host: TopTasksHost): void {
  for (const a of actions()) if (!host.actions.some((x) => x.id === a.id)) host.actions.push(a);

  host.app.use('/__reset', async (c, next) => {
    const body = (await c.req.json().catch(() => ({}))) as { topTasks?: boolean };
    await next();
    if (!body.topTasks) return;
    const S = host.state();
    S.revision = 2;
    S.revisions.unshift({
      revision: 2,
      at: now() - 3600,
      author: OWNER,
      authorName: 'Owner',
      summary: 'Made the relay members-only',
      source: 'ui',
      changes: 1,
    });
  });

  const base = '/api/v1/nodes/:node/config/revisions/:rev';
  host.app.get(`${base}/diff`, (c) => {
    const rev = Number(c.req.param('rev'));
    const S = host.state();
    const diff: Diff[] =
      rev === S.revision
        ? []
        : [
            {
              kind: 'change',
              text: 'Who can post: Only people I approve → Anyone can post',
              technical: 'relays.0.access.mode',
            },
          ];
    return c.json({ diff });
  });
  host.app.post(`${base}/restore`, (c) => {
    const rev = Number(c.req.param('rev'));
    const S = host.state();
    S.revision++;
    const entry: Revision = {
      revision: S.revision,
      at: now(),
      author: OWNER,
      authorName: 'Owner',
      summary: `Restored revision ${rev}`,
      source: 'restore',
      changes: 1,
    };
    S.revisions.unshift(entry);
    S.log.push({ id: 'config.restore', input: { revision: rev } });
    const t = host.token();
    S.undo.set(t, () => {
      S.revisions = S.revisions.filter((r) => r !== entry);
    });
    return c.json({ revision: entry, undo: { token: t, expiresAt: now() + 300 } });
  });
}
