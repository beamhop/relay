// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mock actions for Home, Insights, the launch kit, "Your week" and "Why?"
 * (registered from mock-server.ts; ids already served there win).
 */
import { z } from 'zod';

interface MockAction {
  id: string;
  title: string;
  description: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly?: boolean;
  keywords?: string[];
  input: z.ZodType;
  run: (input: Record<string, unknown>) => { output: unknown; summary: string };
}

interface MockState {
  relay: { hosts: string[]; info: { name: string; description: string; icon?: string } };
  log: Array<{ id: string; input: unknown }>;
}

const MB = 1024 * 1024;
const PK = 'a'.repeat(64);
const SPAMMER = 'b'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);

const wave = (n: number, base: number, amp: number) =>
  Array.from({ length: n }, (_, i) => Math.round((base + amp * Math.sin(i / 2)) * 100) / 100);

export function liveSnapshot() {
  return {
    at: now(),
    relays: [
      {
        relayId: 'main',
        connections: 12,
        eventsPerSecond: 1.5,
        rejectedPerSecond: 0.5,
        rejectedByReason: { 'rate-limited': 0.3, pow: 0.2 },
        acceptRatio: 0.75,
        reqPerSecond: 4,
        p50Ms: 3,
        p95Ms: 42,
        bytesPerSecond: 900,
        blobUploadsPerMinute: 0,
        errorsPerMinute: 0,
        errorRate: 0,
        storageEvents: 1200,
        storageBytes: 5 * MB,
        blobFiles: 14,
        blobBytes: 2 * MB,
      },
    ],
    storage: { events: 1200, bytes: 5 * MB },
    disk: { freeBytes: 40 * 1024 * MB, totalBytes: 100 * 1024 * MB },
  };
}

const METRIC_TITLES: Record<string, string> = {
  connections: 'Connections',
  'events.accepted': 'Posts per second',
  errors: 'Problems per minute',
  'db.size': 'Database size',
  'blobs.bytes': 'Files stored',
  'latency.p95': 'Slowest response times',
  'active-users.daily': 'Active today',
};

export function homeActions(state: () => MockState): MockAction[] {
  return [
    {
      id: 'insights.overview',
      title: 'How is my relay doing?',
      description: 'Health score, live activity and storage at a glance.',
      scope: 'relay',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          health: { score: 92, status: 'ok', message: 'Everything looks healthy' },
          live: liveSnapshot(),
          storage: { events: 1200, bytes: 5 * MB },
        },
        summary: 'Health 92/100',
      }),
    },
    {
      id: 'insights.series',
      title: 'Activity over time',
      description: 'A chart of one number over time.',
      scope: 'relay',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({
        metric: z.string(),
        hours: z.number().default(24),
        labels: z.record(z.string(), z.string()).optional(),
      }),
      run: (i) => {
        const base: Record<string, [number, number]> = {
          connections: [12, 3],
          'events.accepted': [15, 6],
          'events.rejected': [4, 2],
          'event.latency.p95': [40, 10],
          errors: [0.5, 0.5],
        };
        const [b, a] = base[String(i.metric)] ?? [1, 1];
        const t = now();
        return {
          output: {
            metric: i.metric,
            from: t - 3600,
            to: t,
            points: wave(12, b, a).map((v, k) => ({ t: t - (12 - k) * 300, v })),
          },
          summary: '12 data points',
        };
      },
    },
    {
      id: 'insights.analytics',
      title: 'Community',
      description: 'Active people, popular apps and post types.',
      scope: 'relay',
      permission: 'insights.read',
      readOnly: true,
      input: z.object({ days: z.number().int().default(30) }),
      run: () => {
        const days = Array.from({ length: 30 }, (_, k) => ({
          day: new Date((now() - (29 - k) * 86400) * 1000).toISOString().slice(0, 10),
          users: 20 + (k % 7) * 3,
          newUsers: k % 4,
          events: 200 + k * 5,
        }));
        return {
          output: {
            relayId: 'main',
            activeUsers: { daily: 38, weekly: 91, monthly: 240 },
            dailyActive: days,
            topKinds: [
              { kind: 1, name: 'Posts', count: 900 },
              { kind: 7, name: 'Reactions', count: 400 },
              { kind: 30023, name: 'Articles', count: 12 },
            ],
            topClients: [{ name: 'Amethyst', count: 120 }],
            topUserAgents: [
              { name: 'Damus', count: 80 },
              { name: 'amethyst', count: 40 },
            ],
            countries: [
              { country: 'DE', count: 30 },
              { country: 'BR', count: 12 },
            ],
            cohorts: [
              { weekStart: '2026-09-28', size: 40, retained: [20, 14, 10] },
              { weekStart: '2026-10-05', size: 30, retained: [12, 9] },
              { weekStart: '2026-10-12', size: 10, retained: [6] },
            ],
            storageByUser: [
              { pubkey: SPAMMER, bytes: 3 * MB, files: 9 },
              { pubkey: PK, bytes: MB, files: 5 },
            ],
            storageTotal: { bytes: 4 * MB, files: 14, users: 2 },
            geoSource: 'runtime-header',
          },
          summary: '38 active today',
        };
      },
    },
    {
      id: 'experience.launch-kit',
      title: 'Launch kit',
      description: 'Everything to share your relay.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({ baseUrl: z.string().optional() }),
      run: (i) => {
        const s = state();
        s.log.push({ id: 'experience.launch-kit', input: i });
        const polish = [
          {
            field: 'icon',
            text: 'Add an icon — apps show it next to your relay',
            technical: 'NIP-11 `icon` (URL) is missing',
            path: 'info.icon',
            importance: 'recommended',
          },
          {
            field: 'banner',
            text: 'Add a banner image for your landing page',
            technical: 'NIP-11 `banner` (URL) is missing',
            path: 'info.banner',
            importance: 'nice-to-have',
          },
        ];
        const host = s.relay.hosts.find((h) => h !== '*');
        if (!host)
          return {
            output: {
              ok: false,
              needsDomain: true,
              summary:
                'No web address is set yet, so there is nothing to share or test. Add your domain first.',
              technical: 'relay main: hosts = ["*"]',
              link: { screen: '/settings/domains' },
              polish,
            },
            summary: 'Needs a domain',
          };
        const http = `https://${host}`;
        const urls = { relay: `wss://${host}`, blossom: http, landing: `${http}/`, nip11: http };
        const text = `I just opened ${s.relay.info.name} 🎉\n\nAdd it to your client: ${urls.relay}\nMore info: ${urls.landing}`;
        return {
          output: {
            ok: true,
            needsDomain: false,
            urlSource: 'host',
            urls,
            qr: { landing: '<svg/>', relay: '<svg/>' },
            announcement: {
              text,
              published: false,
              draft: {
                kind: 1,
                pubkey: PK,
                created_at: now(),
                content: text,
                tags: [['r', urls.relay]],
              },
            },
            polish,
          },
          summary: 'Launch kit ready — 2 polish tips',
        };
      },
    },
    {
      id: 'experience.my-stats',
      title: 'My time this week',
      description: 'How many minutes you spent managing your relay this week.',
      scope: 'node',
      permission: 'relay.read',
      readOnly: true,
      input: z.object({}),
      run: () => ({
        output: {
          thisWeek: {
            weekStart: 1_792_800_000,
            minutes: 7,
            sessions: 2,
            actions: 5,
            tasksDone: 5,
            suggestionsApproved: 2,
            minutesSaved: 6,
          },
          previousWeeks: [],
          goalMinutes: 10,
          onTrack: true,
          message: 'You spent about 7 minutes on your relay this week — under the 10-minute goal.',
          privacy: 'Measured on this server only and shown only to you. Never sent anywhere.',
        },
        summary: '7 minutes',
      }),
    },
    {
      id: 'experience.why',
      title: 'Why?',
      description: 'Explains a number, a limit, a health score or a suggestion.',
      scope: 'relay',
      permission: 'relay.read',
      readOnly: true,
      input: z.looseObject({ subject: z.string() }),
      run: (i) => {
        state().log.push({ id: 'experience.why', input: i });
        if (i.subject === 'metric') {
          const metric = String(i.metric);
          const title = METRIC_TITLES[metric];
          if (!title)
            return {
              output: {
                title: 'This number',
                cause: `There is no explanation for “${metric}” yet.`,
                options: [],
                technical: [],
                found: false,
              },
              summary: 'unknown',
            };
          return {
            output: {
              title,
              cause: `What this number means, plainly.${i.value !== undefined ? ` Right now: ${i.value}.` : ''} Usually about the same at this time of the week.`,
              options: [{ label: 'Open the charts', screen: '/insights' }],
              technical: [`metric ${metric}`],
              found: true,
            },
            summary: title,
          };
        }
        if (i.subject === 'health')
          return {
            output: {
              title: 'Storage: needs a look',
              cause: 'Disk 82% full (1 of 2 checks are fine)',
              options: [{ label: 'Step-by-step help', playbook: 'disk-full' }],
              technical: ['disk.space [storage] score=80 warn'],
              found: true,
            },
            summary: 'health',
          };
        if (i.subject === 'card')
          return {
            output: {
              title: 'Spam wave',
              cause: 'Many posts from new accounts were refused in the last few minutes.',
              options: [
                { label: 'Not now', actionId: 'experience.snooze-card', input: { key: i.cardId } },
              ],
              technical: [`card ${String(i.cardId)}`],
              found: true,
            },
            summary: 'card',
          };
        return {
          output: {
            title: 'Why?',
            cause: 'No explanation yet.',
            options: [],
            technical: [],
            found: false,
          },
          summary: 'unknown',
        };
      },
    },
  ];
}
