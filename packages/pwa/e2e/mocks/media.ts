// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mock actions of the Media screen: files with storage tiers, storage tiers +
 * "move now", cleanup status, the quarantine review flow and team notes on
 * files. State lives per mock-server state object, so `/__reset` resets it.
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
  bulk?: boolean;
  keywords?: string[];
  input: z.ZodType;
  preview?: (input: Record<string, unknown>) => Diff[];
  run: (input: Record<string, unknown>) => { output: unknown; summary: string; undo?: () => void };
}

const PK = 'a'.repeat(64);
const SPAMMER = 'b'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const MB = 1024 * 1024;
const GB = 1024 * MB;

export const SHA = {
  photo: '1'.repeat(64),
  pdf: 'f'.repeat(64),
  old: '2'.repeat(64),
  ruled: 'c'.repeat(64),
  abuse: 'd'.repeat(64),
};

// 1×1 PNG (the "held" picture preview).
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface Note {
  id: string;
  subject: { type: string; id: string };
  text: string;
  author: string;
  authorName: string;
  at: number;
}

function fresh() {
  return {
    quarantine: [
      {
        sha256: SHA.ruled,
        size: 48_000,
        type: 'image/png',
        uploader: SPAMMER,
        uploaders: 1,
        reason: 'Contains a blocked word',
        source: 'rule',
        abuse: false,
        previewable: true,
        at: now() - 3600,
        technical: `docs blossom.quarantine[${SHA.ruled}] by=plugin:keyword-filter relay=main`,
      },
      {
        sha256: SHA.abuse,
        size: 91_000,
        type: 'image/jpeg',
        uploader: SPAMMER,
        uploaders: 1,
        reason: 'Matched a known-abuse list',
        source: 'abuse-list',
        abuse: true,
        previewable: false,
        at: now() - 600,
        technical: `docs blossom.quarantine[${SHA.abuse}] by=media.scan relay=main (hash-list match; bytes never shown)`,
      },
    ],
    moved: 0,
    lastRun: now() - 2 * 3600,
    hotUsed: Math.round(8.5 * GB),
    coldUsed: 2 * GB,
    notes: [] as Note[],
  };
}

type MediaState = ReturnType<typeof fresh>;
const states = new WeakMap<object, MediaState>();

/** Replace (or add) the media actions in the mock catalog. */
export function registerMediaMocks(actions: Array<{ id: string }>, current: () => object): void {
  const st = (): MediaState => {
    const key = current();
    let s = states.get(key);
    if (!s) {
      s = fresh();
      states.set(key, s);
    }
    return s;
  };
  for (const a of mediaMocks(st)) {
    const i = actions.findIndex((x) => x.id === a.id);
    if (i >= 0) actions.splice(i, 1, a);
    else actions.push(a);
  }
}

function mediaMocks(st: () => MediaState): MockAction[] {
  const sha = z.string().regex(/^[0-9a-f]{64}$/);
  return [
    {
      id: 'media.list-blobs',
      title: 'List media files',
      description: 'See files uploaded to this relay.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ limit: z.number().default(100), cursor: z.string().optional() }),
      run: () => ({
        output: {
          items: [
            {
              relayId: 'main',
              sha256: SHA.photo,
              pubkey: PK,
              size: 120_000,
              type: 'image/png',
              uploadedAt: now() - 50,
              quarantined: false,
              tier: 'hot',
              owners: 2,
            },
            {
              relayId: 'main',
              sha256: SHA.pdf,
              pubkey: PK,
              size: 2048,
              type: 'application/pdf',
              uploadedAt: now() - 100,
              quarantined: false,
              tier: 'hot',
              owners: 1,
            },
            {
              relayId: 'main',
              sha256: SHA.old,
              pubkey: SPAMMER,
              size: 40 * MB,
              type: 'video/mp4',
              uploadedAt: now() - 90 * 86400,
              quarantined: false,
              tier: 'cold',
              owners: 1,
            },
          ],
        },
        summary: '3 files',
      }),
    },
    {
      id: 'media.storage-tiers',
      title: 'Storage tiers',
      description: 'How full the main and the cheaper file storage are.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = st();
        const hotMax = 10 * GB;
        return {
          output: {
            enabled: true,
            afterDays: 30,
            whenHotFull: 'cold',
            tiers: [
              {
                tier: 'hot',
                label: 'Main storage',
                configured: true,
                usedBytes: s.hotUsed,
                count: 1200,
                maxBytes: hotMax,
                fraction: s.hotUsed / hotMax,
                technical: 'hot: fs (blobStorage.driver=fs), maxBytes=10737418240',
              },
              {
                tier: 'cold',
                label: 'Cheaper storage',
                configured: true,
                usedBytes: s.coldUsed,
                count: 300 + s.moved,
                maxBytes: null,
                fraction: null,
                technical: 'cold: s3 (driver=r2, bucket=archive), afterDays=30',
              },
            ],
            job: {
              lastRun: s.lastRun,
              nextRun: s.lastRun + 3600 * 3,
              moved: s.moved,
              movedBytes: s.moved * 50 * MB,
              failed: 0,
              lastError: null,
              totalMoved: 300 + s.moved,
              totalFailed: 0,
              inProgress: false,
            },
            countedAt: s.lastRun,
            error: null,
          },
          summary: 'Storage tiers',
        };
      },
    },
    {
      id: 'media.run-tiering',
      title: 'Move older files now',
      description: 'Move files nobody opened for a while to the cheaper storage now.',
      scope: 'node',
      permission: 'media.write',
      input: z.object({}),
      preview: () => [
        {
          kind: 'change',
          text: 'Files not opened for 30 days move to the cheaper storage. They keep working.',
          technical: 'blossom.tiering run',
        },
      ],
      run: () => {
        const s = st();
        s.moved = 4;
        s.lastRun = now();
        s.hotUsed -= 4 * 50 * MB;
        s.coldUsed += 4 * 50 * MB;
        return {
          output: { moved: 4, movedBytes: 4 * 50 * MB, failed: 0, lastError: null },
          summary: 'Moved 4 files (200 MB)',
        };
      },
    },
    {
      id: 'media.cleanup-status',
      title: 'File cleanup',
      description: 'When unused files were last cleaned up.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          lastRun: now() - 1800,
          nextRun: now() + 1800,
          freedBytes: 12 * MB,
          erased: 3,
          expired: 1,
          scanned: 1500,
          orphans: 1,
          heldRecords: 1,
          totalFreedBytes: 300 * MB,
          inProgress: false,
        },
        summary: 'Last cleanup freed 12 MB',
      }),
    },
    {
      id: 'media.list-quarantine',
      title: 'Quarantined files',
      description: 'Files held back for review.',
      scope: 'relay',
      permission: 'moderation.write',
      readOnly: true,
      input: z.object({ limit: z.number().default(50), cursor: z.string().optional() }),
      run: () => ({
        output: { items: st().quarantine },
        summary: `${st().quarantine.length} quarantined`,
      }),
    },
    {
      id: 'media.quarantine-preview',
      title: 'Preview a quarantined picture',
      description: 'Load a small copy of a held picture.',
      scope: 'relay',
      permission: 'moderation.write',
      readOnly: true,
      input: z.object({ sha256: sha }),
      run: (input) => {
        if (input.sha256 === SHA.abuse)
          throw new Error('Files that matched a known-abuse list are never shown');
        return { output: { dataUrl: PNG, type: 'image/png' }, summary: 'Preview loaded' };
      },
    },
    {
      id: 'media.release-quarantine',
      title: 'Release a quarantined file',
      description: 'The file was held by mistake: make it available again.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      input: z.object({ sha256: sha, note: z.string().optional() }),
      preview: (input) => {
        const item = st().quarantine.find((q) => q.sha256 === input.sha256);
        const lines: Diff[] = [
          { kind: 'change', text: 'The file will be available to everyone again' },
        ];
        if (item?.abuse)
          lines.push({
            kind: 'warning',
            text: 'Matched a known-abuse list. Only release it if you are certain the match is wrong.',
          });
        return lines;
      },
      run: (input) => {
        const s = st();
        const i = s.quarantine.findIndex((q) => q.sha256 === input.sha256);
        const [item] = i >= 0 ? s.quarantine.splice(i, 1) : [];
        return {
          output: { released: !!item },
          summary: 'File released',
          undo: item ? () => void s.quarantine.splice(i, 0, item) : undefined,
        };
      },
    },
    {
      id: 'media.confirm-quarantine',
      title: 'Delete a quarantined file for good',
      description: 'Delete it and refuse it if anyone uploads it again. This cannot be undone.',
      scope: 'relay',
      permission: 'moderation.write',
      bulk: true,
      input: z.object({ sha256: sha, banUploader: z.boolean().default(false) }),
      preview: () => [
        { kind: 'remove', text: 'The file (89 KB) is deleted from this relay' },
        { kind: 'add', text: 'Anyone uploading the same file again is refused' },
        { kind: 'warning', text: 'This cannot be undone.' },
      ],
      run: (input) => {
        const s = st();
        s.quarantine = s.quarantine.filter((q) => q.sha256 !== input.sha256);
        return {
          output: { removed: 1, erased: true, blocked: true, banned: 0 },
          summary: 'File deleted for good and blocked',
        };
      },
    },
    {
      id: 'notes.list',
      title: 'Show internal notes',
      description: 'Notes the admin team left.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({
        subject: z.object({ type: z.string(), id: z.string() }).optional(),
        limit: z.number().default(100),
      }),
      run: (input) => {
        const subj = input.subject as { type: string; id: string } | undefined;
        const notes = st()
          .notes.filter((n) => !subj || (n.subject.type === subj.type && n.subject.id === subj.id))
          .sort((a, b) => b.at - a.at);
        return { output: { notes }, summary: `${notes.length} notes` };
      },
    },
    {
      id: 'notes.add',
      title: 'Add an internal note',
      description: 'Leave a note for the admin team.',
      scope: 'relay',
      permission: 'moderation.write',
      input: z.object({
        subject: z.object({ type: z.enum(['user', 'event', 'blob']), id: z.string() }),
        text: z.string().min(1),
      }),
      preview: () => [{ kind: 'add', text: 'Note added' }],
      run: (input) => {
        const s = st();
        const note: Note = {
          id: `n${s.notes.length + 1}`,
          subject: input.subject as Note['subject'],
          text: String(input.text),
          author: PK,
          authorName: 'Owner',
          at: now(),
        };
        s.notes.push(note);
        return {
          output: { note },
          summary: 'Added a note on file',
          undo: () => {
            s.notes = s.notes.filter((n) => n.id !== note.id);
          },
        };
      },
    },
  ];
}
