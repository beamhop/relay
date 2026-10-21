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
  lastBackup?(): Promise<{ at: number; ok: boolean } | null>;
}

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
  technical: string;
  /** Where to complete it: a PWA screen and/or an action to run. */
  link: { screen: string; actionId?: string; input?: unknown };
}

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
    link: { screen: '/people/admins', actionId: 'admins.recovery-codes', input: {} },
  });

  // 2. Backups.
  let backupsDone = cfg.backups.enabled;
  let backupStatus: string | undefined;
  if (cfg.backups.enabled && lifecycle?.lastBackup) {
    const last = await lifecycle.lastBackup().catch(() => null);
    backupsDone = !!last?.ok;
    if (!backupsDone) backupStatus = 'Backups are on — waiting for the first one to finish.';
  }
  const backupItem: ChecklistItem = {
    id: 'backups',
    title: 'Turn on backups',
    body: 'A daily copy of your relay means a broken disk is a small problem, not a disaster.',
    done: backupsDone,
    available: true,
    technical: `backups.enabled = ${cfg.backups.enabled}; schedule = ${cfg.backups.schedule}${lifecycle?.lastBackup ? '; lifecycle.lastBackup checked' : ''}`,
    link: { screen: '/settings/backups' },
  };
  if (backupStatus) backupItem.status = backupStatus;
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
    link: { screen: '/settings/alerts' },
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
    link: { screen: '/settings/profile' },
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
    link: { screen: '/people/admins', actionId: 'admins.invite', input: { role: 'moderator' } },
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
    link: { screen: '/home/launch-kit', actionId: 'experience.test-relay', input: {} },
  });

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
