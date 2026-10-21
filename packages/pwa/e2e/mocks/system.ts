// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mock `system.*` actions for Settings → Updates & health (E2E). State lives
 * per mock-server state object (`getState()`), so `/__reset` starts fresh.
 *
 * Update: every `system.update-status` poll moves one phase on:
 * backing-up → downloading (50%) → verifying → installing → restarting →
 * (server offline once) → checking → done. Rollback: restarting → offline →
 * rolled-back.
 */
import { z } from 'zod';

type Diff = {
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
  text: string;
  technical?: string;
};

export interface MockAction {
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

const OFFLINE = 'offline' as const;
type Step = string;

interface SystemState {
  current: string;
  previous: string | null;
  phase: string;
  to?: string;
  from?: string;
  queue: Step[];
  backupId?: string;
  message: string;
  advice: string[];
  pruned: boolean;
}

const states = new WeakMap<object, SystemState>();

const UPDATE_STEPS: Step[] = [
  'downloading',
  'verifying',
  'installing',
  'restarting',
  OFFLINE,
  'checking',
  'done',
];

const MESSAGES: Record<string, (s: SystemState) => string> = {
  'backing-up': () => 'Backing up your data',
  downloading: (s) => `Downloading ${s.to}`,
  verifying: () => 'Checking the download',
  installing: (s) => `Installing ${s.to}`,
  restarting: (s) => `Restarting into ${s.to} (about 5 seconds offline)`,
  checking: (s) => `Checking that ${s.to} works`,
  done: (s) => `Updated to ${s.to}. Everything looks healthy.`,
  'rolled-back': (s) => `Went back to ${s.to}.`,
  idle: () => 'No update has run yet',
};

export function systemMockActions(getState: () => object): MockAction[] {
  const st = (): SystemState => {
    const key = getState();
    let s = states.get(key);
    if (!s) {
      s = {
        current: '0.1.0',
        previous: null,
        phase: 'idle',
        queue: [],
        message: MESSAGES.idle!({} as SystemState),
        advice: ['machine-size', 'verify-workers-off', 'disk-forecast'],
        pruned: false,
      };
      states.set(key, s);
    }
    return s;
  };

  const status = (s: SystemState) => ({
    phase: s.phase,
    from: s.from,
    to: s.to,
    updatedAt: 0,
    message: s.message,
    ...(s.backupId ? { backupId: s.backupId } : {}),
    ...(s.phase === 'downloading' ? { progress: { done: 50, total: 100 } } : {}),
    current: s.current,
    previousVersion: s.previous,
    busy: !['idle', 'done', 'failed', 'rolled-back'].includes(s.phase),
  });

  const advance = (s: SystemState) => {
    const next = s.queue.shift();
    if (next === undefined) return;
    if (next === OFFLINE) throw new Error('The server is restarting');
    s.phase = next;
    s.message = MESSAGES[next]?.(s) ?? next;
    if (next === 'done') {
      s.previous = s.from ?? null;
      s.current = s.to ?? s.current;
    }
    if (next === 'rolled-back') {
      s.current = s.to ?? s.current;
      s.previous = null;
    }
  };

  const ADVICE: Record<string, unknown> = {
    'machine-size': {
      id: 'machine-size',
      severity: 'info',
      title: 'Your relay would run comfortably on 1 vCPU / 1 GB',
      body: "With today's traffic, a machine with 1 vCPU, 1 GB of memory and 10 GB of disk leaves room to grow.",
      lens: ['42 connections · 3.1 events/s · database 120 MB · media 2.1 GB'],
    },
    'verify-workers-off': {
      id: 'verify-workers-off',
      severity: 'suggestion',
      title: 'Check signatures on the main thread',
      body: 'This machine has one CPU core, so extra signature-checking threads only add overhead. Takes effect after the next restart.',
      lens: ['node.verifyWorkers: auto → 0', 'running threads: 1'],
      apply: {
        label: 'Use the main thread',
        actionId: 'system.apply-advice',
        input: { id: 'verify-workers-off' },
      },
    },
    'disk-forecast': {
      id: 'disk-forecast',
      severity: 'warning',
      title: 'The disk will be full in about 23 days',
      body: 'Remove old reactions and reposts, keep posts for a shorter time, or move to a bigger disk.',
      lens: ['disk free 9 GB of 40 GB (78% used)', '7-day trend: full in 23 days'],
      apply: { label: 'Free up space', actionId: 'lifecycle.prune-storage', input: {} },
    },
  };

  return [
    {
      id: 'system.update-check',
      title: 'Check for updates',
      description: 'See which version runs now, whether a newer one is out and what changed.',
      scope: 'node',
      permission: 'node.manage',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = st();
        const available = s.current !== '0.2.0';
        return {
          output: {
            current: s.current,
            latest: '0.2.0',
            updateAvailable: available,
            notes: 'Faster sign-in.\nFewer spam reports.',
            notesSummary: 'Faster sign-in.\nFewer spam reports.',
            downloadBytes: 41_943_040,
            canVerify: true,
            signature: 'verifiable',
            allowUnsigned: false,
            install: { kind: 'binary', canSelfUpdate: true, restart: 're-exec' },
            canSelfUpdate: true,
            runtime: 'bun',
            technical:
              'manifest https://get.beamhop.dev/releases/latest.json · install binary · signature verifiable',
          },
          summary: available ? 'Version 0.2.0 is available' : 'You have the latest version',
        };
      },
    },
    {
      id: 'system.update',
      title: 'Update Beamhop',
      description: 'Back up, install the newest version and restart.',
      scope: 'node',
      permission: 'node.manage',
      input: z.object({ version: z.string().optional(), skipBackup: z.boolean().default(false) }),
      preview: () => [
        { kind: 'add', text: 'Back up your data (≈120 MB)', technical: 'backups.run-now' },
        { kind: 'change', text: 'Download version 0.2.0 (40 MB)' },
        { kind: 'info', text: 'Check that it is the genuine release' },
        { kind: 'change', text: 'Restart into 0.2.0 (about 5 seconds offline)' },
        {
          kind: 'info',
          text: 'If the new version is not healthy within a minute, Beamhop goes back by itself',
        },
      ],
      run: () => {
        const s = st();
        if (s.queue.length) throw new Error('An update is already running.');
        s.from = s.current;
        s.to = '0.2.0';
        s.phase = 'backing-up';
        s.message = MESSAGES['backing-up']!(s);
        s.backupId = 'b-1700000000000-abcd';
        s.queue = [...UPDATE_STEPS];
        return { output: status(s), summary: 'Updating to 0.2.0…' };
      },
    },
    {
      id: 'system.update-status',
      title: 'Update progress',
      description: 'Where a running update is.',
      scope: 'node',
      permission: 'node.manage',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = st();
        advance(s);
        return { output: status(s), summary: s.message };
      },
    },
    {
      id: 'system.rollback',
      title: 'Go back to the previous version',
      description: 'Put the version from before the last update back.',
      scope: 'node',
      permission: 'node.manage',
      input: z.object({
        restoreBackup: z
          .boolean()
          .default(false)
          .describe('Also restore the data from before the update (newer changes are lost)'),
      }),
      preview: (input) => [
        { kind: 'change', text: `Go back to version ${st().previous} (about 5 seconds offline)` },
        input.restoreBackup
          ? {
              kind: 'remove',
              text: 'Restore the data from before the update: posts, uploads and changes since then are lost',
            }
          : { kind: 'info', text: 'Your data stays as it is now' },
      ],
      run: (input) => {
        const s = st();
        if (!s.previous) throw new Error('There is no previous version to go back to.');
        s.from = s.current;
        s.to = s.previous;
        s.phase = 'restarting';
        s.message = `Going back to ${s.previous}`;
        s.queue = [OFFLINE, 'rolled-back'];
        return {
          output: { version: s.previous, restored: !!input.restoreBackup },
          summary: `Going back to ${s.previous}…`,
        };
      },
    },
    {
      id: 'system.doctor',
      title: 'Check this setup',
      description: 'Check DNS, certificate, ports, proxy, WebSocket, disk, clock and storage.',
      scope: 'node',
      permission: 'config.write',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = st();
        const results = [
          ...(s.pruned
            ? []
            : [
                {
                  id: 'disk.free',
                  source: 'doctor',
                  tone: 'amber',
                  title: 'Disk space',
                  message: 'Only 9 GB free (22%).',
                  lens: ['check disk.free', 'statfs free=9663676416 total=42949672960'],
                  fix: { label: 'Free up space', actionId: 'lifecycle.prune-storage', input: {} },
                },
              ]),
          {
            id: 'proxy.websocket',
            source: 'doctor',
            tone: 'red',
            title: 'WebSocket',
            message: 'Your proxy does not pass WebSocket connections, so apps cannot connect.',
            lens: ['check proxy.websocket', 'GET /.well-known/beamhop/self-check → no upgrade'],
            advice:
              'Add the Upgrade and Connection headers to your proxy. Run `beamhop doctor --fix` on the server to fix this.',
          },
          {
            id: 'dns.relay.example.com',
            source: 'doctor',
            tone: 'green',
            title: 'DNS',
            message: 'relay.example.com points to this server.',
            lens: ['check dns.relay.example.com', 'A 203.0.113.7'],
          },
          {
            id: 'clock.skew',
            source: 'doctor',
            tone: 'green',
            title: 'Clock',
            message: 'The clock is accurate.',
            lens: ['check clock.skew', 'skew 0.2 s'],
          },
          {
            id: 'insights.latency',
            source: 'health',
            tone: 'green',
            title: 'Speed',
            message: 'Posts are handled quickly',
            lens: ['health check insights.latency · score 100'],
          },
        ];
        const counts = { green: 0, amber: 0, red: 0, grey: 0 } as Record<string, number>;
        for (const r of results) counts[r.tone] = (counts[r.tone] ?? 0) + 1;
        return {
          output: { at: 0, results, counts, fullChecks: true },
          summary: `${counts.red} problem(s), ${counts.amber} warning(s)`,
        };
      },
    },
    {
      id: 'system.advisor',
      title: 'Resource advice',
      description: 'Machine size and settings that fit your traffic and storage.',
      scope: 'node',
      permission: 'config.write',
      readOnly: true,
      input: z.object({}),
      run: () => {
        const s = st();
        return {
          output: {
            at: 0,
            size: { vcpus: 1, memoryGb: 1, diskGb: 10 },
            advice: s.advice.map((id) => ADVICE[id]),
          },
          summary: 'Your relay would run comfortably on 1 vCPU / 1 GB',
        };
      },
    },
    {
      id: 'system.apply-advice',
      title: 'Apply resource advice',
      description: 'Make the settings change a resource suggestion recommends.',
      scope: 'node',
      permission: 'node.manage',
      input: z.object({ id: z.enum(['verify-workers-off', 'verify-workers-on']) }),
      preview: () => [
        {
          kind: 'change',
          text: 'Check signatures on the main thread (after the next restart)',
          technical: 'node.verifyWorkers: auto → 0',
        },
      ],
      run: (input) => {
        const s = st();
        const before = [...s.advice];
        s.advice = s.advice.filter((a) => a !== input.id);
        return {
          output: { restartNeeded: true },
          summary: 'Signatures checked on the main thread after the next restart',
          undo: () => {
            s.advice = before;
          },
        };
      },
    },
    {
      id: 'lifecycle.prune-storage',
      title: 'Free up storage',
      description: 'Remove the oldest reactions and reposts.',
      scope: 'relay',
      permission: 'config.write',
      input: z.object({}),
      preview: () => [{ kind: 'remove', text: 'Remove 1,204 old reactions and reposts (≈2 GB)' }],
      run: () => {
        const s = st();
        s.pruned = true;
        s.advice = s.advice.filter((a) => a !== 'disk-forecast');
        return {
          output: { removed: 1204 },
          summary: 'Removed 1,204 old reactions and reposts',
          undo: () => {
            s.pruned = false;
          },
        };
      },
    },
  ];
}
