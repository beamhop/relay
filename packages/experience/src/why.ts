// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Why?" everywhere (§6.10): for a refused post, a limit, a health score or a
 * Home card, return the plain cause, what the admin can do about it, and a
 * technical lens. Read-only.
 */
import {
  type AppEvents,
  type HealthResult,
  type Kernel,
  type Principal,
  type RelayId,
  type Subsystem,
  can,
} from '@beamhop/core';
import { type LimitExplanation, explainLimits } from '@beamhop/policy';
import type { SuggestionsEngine } from './inbox.ts';
import { HOOK_LABELS } from './simulate.ts';

export interface WhyOption {
  label: string;
  actionId?: string;
  input?: unknown;
  playbook?: string;
  /** PWA screen to open. */
  screen?: string;
}

export interface WhyAnswer {
  title: string;
  /** Plain cause. */
  cause: string;
  options: WhyOption[];
  /** Technical lens lines. */
  technical: string[];
  found: boolean;
}

export type WhySubject =
  | { subject: 'rejected-event'; eventId: string }
  | { subject: 'limit'; field: string; tier?: string }
  | { subject: 'health'; subsystem?: Subsystem; checkId?: string }
  | { subject: 'card'; cardId: string };

export interface RejectionRecord {
  relayId: RelayId;
  eventId: string;
  pubkey: string;
  kind: number;
  reason: string;
  by?: string;
  at: number;
  decision: 'reject' | 'hold';
}

/** Fixed-size ring buffer of recent refusals and holds (in memory, never persisted). */
export class RejectionRing {
  private buf: RejectionRecord[] = [];
  constructor(readonly capacity = 500) {}
  push(r: RejectionRecord): void {
    this.buf.push(r);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }
  find(eventId: string, relayId?: RelayId | null): RejectionRecord | undefined {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const r = this.buf[i]!;
      if (r.eventId === eventId && (!relayId || r.relayId === relayId)) return r;
    }
    return undefined;
  }
  recent(limit = 50, relayId?: RelayId | null): RejectionRecord[] {
    const out: RejectionRecord[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.buf[i]!;
      if (!relayId || r.relayId === relayId) out.push(r);
    }
    return out;
  }
  attach(kernel: Kernel): Array<() => void> {
    const now = () => kernel.ports.clock.now();
    return [
      kernel.bus.on('event.rejected', (e: AppEvents['event.rejected']) => {
        const rec: RejectionRecord = {
          relayId: e.relayId,
          eventId: e.eventId,
          pubkey: e.pubkey,
          kind: e.kind,
          reason: e.reason,
          at: now(),
          decision: 'reject',
        };
        if (e.by) rec.by = e.by;
        this.push(rec);
      }),
      kernel.bus.on('event.held', (e: AppEvents['event.held']) => {
        const rec: RejectionRecord = {
          relayId: e.relayId,
          eventId: e.event.id,
          pubkey: e.event.pubkey,
          kind: e.event.kind,
          reason: e.reason ?? 'held for review',
          at: now(),
          decision: 'hold',
        };
        if (e.by) rec.by = e.by;
        this.push(rec);
      }),
    ];
  }
}

/** What an admin can do about a refusal by a given filter. */
const REJECTION_OPTIONS: Record<string, { cause: string; options: WhyOption[]; fields: string[] }> =
  {
    'policy.pow': {
      cause:
        'The post did not include enough "proof of work" — a small puzzle new or unknown accounts must solve here.',
      options: [
        { label: 'Make the puzzle easier', screen: '/settings/goals' },
        {
          label: 'Add this person as a member (no puzzle)',
          actionId: 'access.add-allowlist',
        },
      ],
      fields: ['minPowDifficulty', 'newKeyPowDifficulty'],
    },
    'policy.rate-limit': {
      cause: 'This account posted faster than your relay allows.',
      options: [
        { label: 'Allow more posts per minute', screen: '/settings/goals' },
        { label: 'Give this person a higher tier', actionId: 'users.set-tier' },
      ],
      fields: ['eventsPerMinute'],
    },
    'policy.event-size': {
      cause: 'The post was larger than your relay accepts.',
      options: [{ label: 'Allow bigger posts', screen: '/settings/goals' }],
      fields: ['maxEventBytes'],
    },
    'policy.kinds': {
      cause: 'This type of content is not accepted on your relay.',
      options: [{ label: 'Change which content is allowed', screen: '/settings/advanced' }],
      fields: ['allowedKinds', 'blockedKinds'],
    },
    'policy.created-at': {
      cause:
        'The post was dated too far in the future or past — usually a wrong clock on the sender’s device.',
      options: [{ label: 'Change the allowed time range', screen: '/settings/advanced' }],
      fields: ['maxCreatedAtFutureSeconds', 'maxCreatedAtPastSeconds'],
    },
    'policy.access': {
      cause:
        'Only members (or trusted people) can post on your relay, and this account is not one.',
      options: [
        { label: 'Add this person as a member', actionId: 'access.add-allowlist' },
        { label: 'Create an invite', actionId: 'access.create-invite' },
      ],
      fields: [],
    },
    'policy.auth': {
      cause: 'Your relay asks people to sign in before posting, and this app had not signed in.',
      options: [{ label: 'Change who must sign in', screen: '/settings/access' }],
      fields: [],
    },
    'policy.banned': {
      cause: 'This account is blocked on your relay.',
      options: [{ label: 'Unblock this account', actionId: 'moderation.unban-pubkey' }],
      fields: [],
    },
    'policy.recycled': {
      cause:
        'A moderator removed this post earlier; it cannot be posted again while in the recycle bin.',
      options: [{ label: 'Open the recycle bin', actionId: 'moderation.recycle-bin', input: {} }],
      fields: [],
    },
    'policy.duplicate': {
      cause: 'The same (or almost the same) text was just posted — a common spam pattern.',
      options: [
        { label: 'Relax spam blocking', screen: '/settings/goals' },
        { label: 'Spam attack help', playbook: 'spam-attack' },
      ],
      fields: ['duplicateWindowSeconds', 'nearDuplicateDistance'],
    },
    'policy.content': {
      cause: 'The post had too many links, or a blocked link or phrase.',
      options: [{ label: 'Relax spam blocking', screen: '/settings/goals' }],
      fields: ['maxLinks'],
    },
    'policy.mute': {
      cause: 'This account is muted: its posts are accepted quietly but not shown.',
      options: [{ label: 'Unmute this account', actionId: 'moderation.unmute-pubkey' }],
      fields: [],
    },
  };

const SUBSYSTEM_PLAYBOOK: Partial<Record<Subsystem, string>> = {
  storage: 'disk-full',
  network: 'certificate-problem',
  relay: 'relay-is-slow',
  moderation: 'spam-attack',
  security: 'lost-admin-access',
};

const SUBSYSTEM_LABEL: Record<Subsystem, string> = {
  relay: 'Relay',
  blossom: 'Media hosting',
  storage: 'Storage',
  network: 'Network',
  moderation: 'Moderation',
  backups: 'Backups',
  security: 'Security',
};

function limitLines(kernel: Kernel, relayId: RelayId, tier?: string): LimitExplanation[] {
  const svc = kernel.use<{ explainLimits(r: RelayId, t?: string): LimitExplanation[] }>('policy');
  if (svc) return svc.explainLimits(relayId, tier);
  const relay = kernel.relay(relayId);
  return relay ? explainLimits(relay, tier) : [];
}

const notFound = (title: string, cause: string): WhyAnswer => ({
  title,
  cause,
  options: [],
  technical: [],
  found: false,
});

export async function explainWhy(
  kernel: Kernel,
  relayId: RelayId | null,
  q: WhySubject,
  deps: { ring: RejectionRing; engine: SuggestionsEngine },
  opts: { principal?: Principal } = {},
): Promise<WhyAnswer> {
  switch (q.subject) {
    case 'rejected-event': {
      const r = deps.ring.find(q.eventId, relayId);
      if (!r)
        return notFound(
          'Refused post',
          'This post is not in the recent list any more (only the latest refusals are kept, and only since the last restart).',
        );
      const by = r.by ?? 'unknown';
      const known = REJECTION_OPTIONS[by];
      const technical = [
        `${by} → "${r.reason}"`,
        `kind ${r.kind}, pubkey ${r.pubkey}, event ${r.eventId}`,
      ];
      const options = (known?.options ?? []).map((o) =>
        o.actionId && !o.input
          ? {
              ...o,
              input:
                o.actionId === 'users.set-tier'
                  ? { pubkey: r.pubkey }
                  : o.actionId === 'access.create-invite'
                    ? {}
                    : { pubkeys: [r.pubkey] },
            }
          : o,
      );
      if (known?.fields.length && kernel.relay(r.relayId)) {
        for (const line of limitLines(kernel, r.relayId)) {
          if (known.fields.includes(line.field)) technical.push(`${line.technical} — ${line.text}`);
        }
      }
      const label = HOOK_LABELS[by] ?? 'Refused by a filter';
      return {
        title: r.decision === 'hold' ? `Held for review: ${label}` : `Refused: ${label}`,
        cause: known?.cause ?? `A filter (${by}) stopped this post: ${r.reason}`,
        options,
        technical,
        found: true,
      };
    }
    case 'limit': {
      const rid = relayId ?? kernel.config().relays[0]?.id;
      if (!rid) return notFound('Limit', 'There is no relay yet.');
      const line = limitLines(kernel, rid, q.tier).find((l) => l.field === q.field);
      if (!line) return notFound('Limit', `There is no limit called “${q.field}”.`);
      const options: WhyOption[] = [];
      if (line.source === 'override')
        options.push({
          label: 'Go back to the value your goals suggest',
          screen: '/settings/advanced',
        });
      else if (line.source === 'goal' && line.goal)
        options.push({ label: `Move the ${line.goal} goal`, screen: '/settings/goals' });
      else if (line.source === 'tier')
        options.push({ label: 'Change the tier', screen: '/people?tab=users' });
      options.push({ label: 'Override it in Advanced', screen: '/settings/advanced' });
      options.push({
        label: 'Try a different value on recent traffic first',
        actionId: 'experience.simulate-change',
      });
      return {
        title: `Why ${line.field}?`,
        cause: line.text,
        options,
        technical: [line.technical, `source: ${line.source}`],
        found: true,
      };
    }
    case 'health': {
      const checks = kernel.health.filter(
        (h) => (!q.checkId || h.id === q.checkId) && (!q.subsystem || h.subsystem === q.subsystem),
      );
      if (checks.length === 0)
        return notFound('Health', 'Nothing is being checked for this part of the relay.');
      const results: Array<{ id: string; subsystem: Subsystem; r: HealthResult }> = [];
      for (const h of checks) {
        try {
          results.push({ id: h.id, subsystem: h.subsystem, r: await h.run(relayId) });
        } catch (err) {
          results.push({
            id: h.id,
            subsystem: h.subsystem,
            r: {
              score: 0,
              status: 'critical',
              message: 'This check failed to run.',
              technical: String(err),
            },
          });
        }
      }
      const worst = [...results].sort((a, b) => a.r.score - b.r.score)[0]!;
      const sub = q.subsystem ?? worst.subsystem;
      const options: WhyOption[] = [];
      const pb = SUBSYSTEM_PLAYBOOK[worst.subsystem];
      if (worst.r.status !== 'ok' && pb) options.push({ label: 'Step-by-step help', playbook: pb });
      return {
        title: `${SUBSYSTEM_LABEL[sub]}: ${worst.r.status === 'ok' ? 'healthy' : worst.r.status === 'warn' ? 'needs a look' : 'needs you now'}`,
        cause:
          results.length === 1
            ? worst.r.message
            : `${worst.r.message} (${results.filter((x) => x.r.status === 'ok').length} of ${results.length} checks are fine)`,
        options,
        technical: results.map(
          (x) =>
            `${x.id} [${x.subsystem}] score=${x.r.score} ${x.r.status}${x.r.technical ? ` — ${x.r.technical}` : ''}`,
        ),
        found: true,
      };
    }
    case 'card': {
      const c = await deps.engine.find(q.cardId);
      if (!c || (opts.principal && !can(opts.principal, 'relay.read', c.relayId)))
        return notFound(
          'Suggestion',
          'This suggestion is gone — the problem may have resolved itself.',
        );
      const options: WhyOption[] = [];
      if (c.primary)
        options.push({
          label: c.primary.label,
          actionId: 'experience.approve-card',
          input: { key: c.key },
        });
      if (c.secondary)
        options.push({
          label: c.secondary.label,
          actionId: c.secondary.actionId,
          input: c.secondary.inputs[0],
        });
      if (c.playbook) options.push({ label: 'Step-by-step help', playbook: c.playbook });
      options.push({ label: 'Not now', actionId: 'experience.snooze-card', input: { key: c.key } });
      options.push({
        label: 'Dismiss',
        actionId: 'experience.dismiss-card',
        input: { key: c.key },
      });
      return {
        title: c.title,
        cause: c.body,
        options,
        technical: [
          `card ${c.key} from ${c.sources.join(', ')}; ${c.count} member(s): ${c.members.slice(0, 10).join(', ')}`,
          ...(c.technical ? [c.technical] : []),
          ...(c.primary ? [`primary: ${c.primary.actionId} × ${c.primary.inputs.length}`] : []),
        ],
        found: true,
      };
    }
  }
}
