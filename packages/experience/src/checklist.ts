// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * First-week setup checklist (§7): a short list on Home with a progress ring.
 * Every item is checked from real state (never self-reported) and links to the
 * screen or action that completes it. Once everything is done the checklist
 * hides itself for good.
 */
import { type Kernel, type RelayId, RelayInfoSchema } from '@beamhop/core';
import type { TestRelayReport } from './launch-kit.ts';
import { COL } from './util.ts';

/** Duck-typed `kernel.use('admin.directory')` (admin-api). */
export interface DirectoryLike {
  list(): Promise<Array<{ id: string }>>;
  recoveryCodesLeft(): Promise<number>;
}

/**
 * Duck-typed `kernel.use('lifecycle')` (lifecycle module, optional).
 * When present, "backups configured" also requires one successful backup.
 */
export interface LifecycleLike {
  lastBackup?(): Promise<{ at: number; ok: boolean; error?: string } | null>;
  /** True while a backup is being made (lifecycle starts the first one when backups turn on). */
  backupInProgress?(): boolean;
}

/** Finer state of a checklist item, for a status chip next to it. */
export type ChecklistItemState = 'done' | 'todo' | 'in-progress' | 'failed';

export type ChecklistItemId =
  | 'recovery-codes'
  | 'backups'
  | 'alerts'
  | 'landing-page'
  | 'moderator'
  | 'test-relay';

export interface ChecklistItem {
  id: ChecklistItemId;
  title: string;
  /** Why it matters, in one plain sentence. */
  body: string;
  done: boolean;
  /** False when the module that tracks this item is not installed; not counted. */
  available: boolean;
  /** Extra state, e.g. "Backups are on, waiting for the first one to finish". */
  status?: string;
  /** Finer state than `done` (e.g. a backup still running, or one that failed). */
  state?: ChecklistItemState;
  /** Plain text describing `state`, e.g. "Backups are on — making the first copy…". */
  detail?: string;
  technical: string;
  /**
   * Where to complete it: a real admin-app route (see {@link PWA_ROUTES}) and/or an
   * action to run. `related` names extra actions the app may offer next to it
   * (e.g. the launch kit, which is an action, not a screen).
   */
  link: {
    screen: string;
    actionId?: string;
    input?: unknown;
    related?: Array<{ actionId: string; input?: unknown }>;
  };
}

/**
 * Admin app (packages/pwa) routes the server links to. Settings sections are
 * `/settings/<simple screen id>`; the People screen selects its tab with `?tab=`.
 */
export const PWA_ROUTES = {
  home: '/',
  team: '/people?tab=team',
  people: '/people?tab=users',
  security: '/settings/security',
  backups: '/settings/backups',
  alerts: '/settings/alerts',
  profile: '/settings/profile',
} as const;

export interface Checklist {
  items: ChecklistItem[];
  done: number;
  total: number;
  /** 0..100 for the progress ring. */
  percent: number;
  complete: boolean;
  /** Hidden once complete (and stays hidden afterwards). */
  hidden: boolean;
  completedAt?: number;
}

interface ChecklistDoc {
  completedAt?: number;
}

const DEFAULT_INFO = RelayInfoSchema.parse({});

export function landingCustomized(info: { name: string; description: string }): boolean {
  return info.name.trim() !== DEFAULT_INFO.name && info.description.trim() !== '';
}

export async function buildChecklist(
  kernel: Kernel,
  relayId: RelayId | null = null,
): Promise<Checklist> {
  const cfg = kernel.config();
  const dir = kernel.use<DirectoryLike>('admin.directory');
  const lifecycle = kernel.use<LifecycleLike>('lifecycle');
  const relays = relayId ? cfg.relays.filter((r) => r.id === relayId) : cfg.relays;
  const items: ChecklistItem[] = [];

  // 1. Owner recovery codes.
  const codes = dir ? await dir.recoveryCodesLeft().catch(() => 0) : 0;
  items.push({
    id: 'recovery-codes',
    title: 'Save your recovery codes',
    body: 'If you ever lose your key, these one-time codes get you back in.',
    done: codes > 0,
    available: !!dir,
    technical: `admin.recovery codes left = ${codes}`,
    link: { screen: PWA_ROUTES.security, actionId: 'admins.recovery-codes', input: {} },
  });

  // 2. Backups.
  let backupsDone = cfg.backups.enabled;
  let backupState: ChecklistItemState = backupsDone ? 'done' : 'todo';
  let backupStatus: string | undefined;
  let backupTech = '';
  if (cfg.backups.enabled && lifecycle?.lastBackup) {
    const last = await lifecycle.lastBackup().catch(() => null);
    const running = lifecycle.backupInProgress?.() ?? false;
    backupsDone = !!last?.ok;
    if (backupsDone) backupState = 'done';
    else if (running || !last) {
      backupState = 'in-progress';
      backupStatus = running
        ? 'Backups are on — making the first copy…'
        : 'Backups are on — waiting for the first one to finish.';
    } else {
      backupState = 'failed';
      backupStatus = `The last backup failed: ${last.error ?? 'unknown error'}`;
    }
    backupTech = `; last = ${last ? (last.ok ? 'ok' : 'failed') : 'none'}; running = ${running}`;
  }
  const backupItem: ChecklistItem = {
    id: 'backups',
    title: 'Turn on backups',
    body: 'A daily copy of your relay means a broken disk is a small problem, not a disaster.',
    done: backupsDone,
    available: true,
    state: backupState,
    technical: `backups.enabled = ${cfg.backups.enabled}; schedule = ${cfg.backups.schedule}${lifecycle?.lastBackup ? `; lifecycle.lastBackup checked${backupTech}` : ''}`,
    link: { screen: PWA_ROUTES.backups },
  };
  if (backupStatus) {
    backupItem.status = backupStatus;
    backupItem.detail = backupStatus;
  }
  items.push(backupItem);

  // 3. Alerts channel.
  const channels = cfg.alerts.channels.length;
  items.push({
    id: 'alerts',
    title: 'Get alerts on your phone',
    body: 'Beamhop only pings you when something needs you.',
    done: channels > 0,
    available: true,
    technical: `alerts.channels.length = ${channels}`,
    link: { screen: PWA_ROUTES.alerts },
  });

  // 4. Landing page.
  const custom = relays.filter((r) => landingCustomized(r.info));
  items.push({
    id: 'landing-page',
    title: 'Make your landing page yours',
    body: 'Give your relay a name and a short description so people know what it is for.',
    done: relays.length > 0 && custom.length === relays.length,
    available: relays.length > 0,
    technical: `relays[].info.name != "${DEFAULT_INFO.name}" and info.description set (${custom.length}/${relays.length})`,
    link: { screen: PWA_ROUTES.profile },
  });

  // 5. Moderator invited.
  const admins = dir ? await dir.list().catch(() => []) : [];
  items.push({
    id: 'moderator',
    title: 'Invite a moderator',
    body: 'A second person can help with reports and keep things running while you are away.',
    done: admins.length > 1,
    available: !!dir,
    technical: `admin directory size = ${admins.length}`,
    link: { screen: PWA_ROUTES.team, actionId: 'admins.invite', input: { role: 'moderator' } },
  });

  // 6. Test my relay.
  const runs = await Promise.all(
    relays.map((r) => kernel.ports.docs.get<TestRelayReport>(COL.testRuns, r.id)),
  );
  const passed = runs.filter((r) => r?.ok).length;
  items.push({
    id: 'test-relay',
    title: 'Test your relay from the outside',
    body: 'Checks that people on the internet can connect, post, read and upload.',
    done: relays.length > 0 && passed === relays.length,
    available: relays.length > 0,
    technical: `experience.test-relay passed for ${passed}/${relays.length} relays`,
    link: {
      screen: PWA_ROUTES.home,
      actionId: 'experience.test-relay',
      input: {},
      related: [{ actionId: 'experience.launch-kit', input: {} }],
    },
  });

  for (const i of items) i.state ??= i.done ? 'done' : 'todo';
  const counted = items.filter((i) => i.available);
  const done = counted.filter((i) => i.done).length;
  const complete = counted.length > 0 && done === counted.length;

  const meta = (await kernel.ports.docs.get<ChecklistDoc>(COL.checklist, 'checklist')) ?? {};
  let completedAt = meta.completedAt;
  // Only the node-wide checklist is remembered as finished.
  if (complete && completedAt === undefined && relayId === null) {
    completedAt = kernel.ports.clock.now();
    await kernel.ports.docs.put<ChecklistDoc>(COL.checklist, 'checklist', { completedAt });
  }
  const out: Checklist = {
    items,
    done,
    total: counted.length,
    percent: counted.length ? Math.round((done / counted.length) * 100) : 100,
    complete,
    hidden: complete || completedAt !== undefined,
  };
  if (completedAt !== undefined) out.completedAt = completedAt;
  return out;
}
