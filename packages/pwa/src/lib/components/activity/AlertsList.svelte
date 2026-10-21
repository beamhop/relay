<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Alerts: open and recent alerts from the alerts module when it is installed (`alerts.list`),
   * otherwise the current warnings and recent errors.
   * Per alert (§8): one-tap snooze (swipe) or mute, "Why?", and the muted/snoozed state.
   * Above the list: who is on call now (§6.12), the digest (§6.9) and one tip.
   */
  import { onMount } from 'svelte';
  import BellRing from '@lucide/svelte/icons/bell-ring';
  import BellOff from '@lucide/svelte/icons/bell-off';
  import Clock from '@lucide/svelte/icons/clock';
  import UserRound from '@lucide/svelte/icons/user-round';
  import Lightbulb from '@lucide/svelte/icons/lightbulb';
  import X from '@lucide/svelte/icons/x';
  import type { AttentionCard } from '$lib/api/types';
  import { app } from '$lib/stores/app.svelte';
  import { query, runNow } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { ago } from '$lib/utils';
  import { to } from '$lib/nav';
  import SwipeRow, { type RowAction } from '../SwipeRow.svelte';
  import WhyButton from '../WhyButton.svelte';
  import ItemLens from '../ItemLens.svelte';
  import Badge from '../ui/badge.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import DigestSettings from './DigestSettings.svelte';
  import { admins } from './admins.svelte';
  import { type MuteRecord, SNOOZES, type SnoozeId, muteFor, unmuteInput } from './alerts';
  import { m } from '$lib/paraglide/messages.js';

  interface AlertRow {
    id: string;
    at: number;
    title: string;
    body?: string;
    severity: 'info' | 'warning' | 'critical';
    technical?: string;
    resolved?: boolean;
    /** Alerts-module rows: the kind of alert and where (mute/snooze target). */
    rule?: string;
    relayId?: string | null;
  }
  interface OnCall {
    onDuty: { principalId: string } | null;
    until: number | null;
  }

  let rows = $state<AlertRow[] | null>(null);
  let mutes = $state<MuteRecord[]>([]);
  let fromModule = $state(false);
  let oncall = $state<OnCall | null>(null);
  let tip = $state<{ id: string; text: string } | null>(null);
  let snoozing = $state<string | null>(null);
  let nowSec = $state(Math.floor(Date.now() / 1000));

  const canSnooze = $derived(app.can('moderation.write') && app.hasAction('alerts.snooze'));
  const canMute = $derived(app.can('config.write') && app.hasAction('alerts.mute'));

  type Rec = {
    id: string;
    lastAt: number;
    title: string;
    body: string;
    severity: 'warning' | 'critical';
    technical?: string;
    resolvedAt?: number;
    rule: string;
    relayId: string | null;
  };

  async function loadModule(): Promise<boolean> {
    const listed = await query<{ active: Rec[]; recent: Rec[]; mutes?: MuteRecord[] }>('alerts.list');
    if (!listed) return false;
    fromModule = true;
    mutes = listed.mutes ?? [];
    nowSec = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    rows = [...listed.active, ...listed.recent]
      .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
      .map((a) => {
        const r: AlertRow = {
          id: a.id,
          at: a.resolvedAt ?? a.lastAt,
          title: a.title,
          body: a.body,
          severity: a.severity,
          rule: a.rule,
          relayId: a.relayId,
        };
        if (a.resolvedAt) r.resolved = true;
        if (a.technical) r.technical = a.technical;
        return r;
      });
    return true;
  }

  async function loadExtras() {
    if (app.hasAction('alerts.oncall')) {
      void admins.ensure();
      oncall = await query<OnCall>('alerts.oncall');
    }
    if (app.hasAction('alerts.tips')) {
      const t = await query<{ tips: Array<{ id: string; text: string }> }>('alerts.tips');
      // One tip at a time, changing by day.
      const list = t?.tips ?? [];
      tip = list.length ? (list[Math.floor(Date.now() / 86_400_000) % list.length] ?? null) : null;
    }
  }

  onMount(async () => {
    void loadExtras();
    if (await loadModule()) return;
    const cards: AttentionCard[] = await app.api.cards(!!app.relayId).catch(() => []);
    const current: AlertRow[] = cards
      .filter((c) => c.severity !== 'info')
      .map((c) => {
        const r: AlertRow = { id: c.id, at: c.createdAt, title: c.title, body: c.body, severity: c.severity };
        if (c.technical) r.technical = c.technical;
        return r;
      });
    const errors: AlertRow[] = live.items
      .filter((i) => i.name === 'error')
      .slice(0, 50)
      .map((i) => ({
        id: `live-${i.seq}`,
        at: i.at,
        title: String(i.data.message ?? m.error_generic()),
        severity: 'critical' as const,
        technical: String(i.data.source ?? ''),
      }));
    rows = [...current, ...errors].sort((a, b) => (b.at < 1e12 ? b.at * 1000 : b.at) - (a.at < 1e12 ? a.at * 1000 : a.at));
  });

  const target = (r: AlertRow) => ({ rule: r.rule as string, relayId: r.relayId ?? null });

  async function snooze(r: AlertRow, id: SnoozeId) {
    snoozing = null;
    const minutes = SNOOZES.find((s) => s.id === id)?.minutes ?? 60;
    const done = await runNow('alerts.snooze', { ...target(r), minutes }, { afterUndo: () => void loadModule() });
    if (done) await loadModule();
  }
  async function mute(r: AlertRow) {
    const done = await runNow('alerts.mute', target(r), { afterUndo: () => void loadModule() });
    if (done) await loadModule();
  }
  async function unmute(mr: MuteRecord) {
    const done = await runNow('alerts.unmute', unmuteInput(mr), { afterUndo: () => void loadModule() });
    if (done) await loadModule();
  }
  async function hideTip() {
    if (!tip) return;
    const id = tip.id;
    tip = null;
    await runNow('alerts.dismiss-tip', { tipId: id }, { afterUndo: () => void loadExtras() });
  }

  function rowActions(r: AlertRow): RowAction[] {
    if (!r.rule || muteFor(mutes, r.rule, r.relayId ?? null, nowSec)) return [];
    const out: RowAction[] = [];
    if (canSnooze) out.push({ id: 'snooze', label: m.act_alert_snooze_1d(), tone: 'warn', run: () => void snooze(r, '1d') });
    if (canMute) out.push({ id: 'mute', label: m.act_alert_mute(), tone: 'neutral', run: () => void mute(r) });
    return out;
  }

  const snoozeText: Record<SnoozeId, () => string> = {
    '1h': () => m.act_alert_1h(),
    '8h': () => m.act_alert_8h(),
    '1d': () => m.act_alert_1d(),
    '1w': () => m.act_alert_1w(),
  };
  const fmtUntil = (t: number) =>
    new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
</script>

{#if oncall}
  <a
    href={to('/activity/on-call')}
    class="mb-3 flex items-center gap-3 rounded-xl border p-3 text-sm hover:bg-muted/50"
    data-testid="oncall-now"
  >
    <UserRound class="size-4 shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1">
      {#if oncall.onDuty}
        {m.act_oncall_now({ name: admins.name(oncall.onDuty.principalId) })}
        {#if oncall.until}<span class="block text-xs text-muted-foreground">{m.act_oncall_until({ when: fmtUntil(oncall.until) })}</span>{/if}
      {:else}
        {m.act_oncall_none()}
      {/if}
    </span>
    <span class="text-xs text-primary">{m.act_oncall_schedule()}</span>
  </a>
{/if}

{#if fromModule}
  <div class="mb-3"><DigestSettings /></div>
{/if}

{#if tip}
  <div class="mb-3 flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="alerts-tip">
    <Lightbulb class="mt-0.5 size-4 shrink-0 text-primary" />
    <p class="min-w-0 flex-1">{tip.text}</p>
    <button type="button" class="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label={m.act_tip_hide()} onclick={hideTip} data-testid="alerts-tip-hide">
      <X class="size-4" />
    </button>
  </div>
{/if}

{#if rows === null}
  <Skeleton class="h-40 w-full" />
{:else}
  {#if !fromModule}
    <p class="mb-3 text-xs text-muted-foreground">
      {m.alerts_fallback()} <a class="text-primary" href={to('/settings/alerts')}>{m.alerts_configure()}</a>
    </p>
  {/if}
  {#if rows.length === 0}
    <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
      <BellRing class="size-6" />
      {m.alerts_empty()}
    </div>
  {:else}
    <ul class="divide-y overflow-hidden rounded-xl border" data-testid="alerts-list">
      {#each rows as r (r.id)}
        {@const muted = r.rule ? muteFor(mutes, r.rule, r.relayId ?? null, nowSec) : undefined}
        <li data-testid="alert-row" data-muted={muted ? (muted.until === null ? 'muted' : 'snoozed') : undefined}>
          <SwipeRow right={rowActions(r)}>
            <div class="flex gap-3 p-3">
              <Badge tone={r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warn' : 'neutral'}>
                {r.severity === 'critical' ? m.severity_critical() : r.severity === 'warning' ? m.severity_warning() : m.severity_info()}
              </Badge>
              <div class="min-w-0 flex-1">
                <p class="text-sm">{names.text(r.title)}</p>
                {#if r.body}<p class="text-xs text-muted-foreground">{names.text(r.body)}</p>{/if}
                {#if r.resolved}<p class="text-xs text-success">{m.alerts_resolved()}</p>{/if}
                {#if muted}
                  <p class="mt-1 flex items-center gap-1 text-xs text-muted-foreground" data-testid="alert-muted">
                    {#if muted.until === null}<BellOff class="size-3" />{m.act_alert_muted()}{:else}<Clock class="size-3" />{m.act_alert_snoozed({ when: fmtUntil(muted.until) })}{/if}
                    {#if canMute}
                      <button type="button" class="ml-1 text-primary" onclick={() => unmute(muted)} data-testid="alert-unmute">{m.act_alert_unmute()}</button>
                    {/if}
                    {#if muted.until !== null && canSnooze}
                      <button
                        type="button"
                        class="ml-1 text-primary"
                        aria-expanded={snoozing === r.id}
                        onclick={() => (snoozing = snoozing === r.id ? null : r.id)}
                        data-testid="alert-snooze-longer">{m.tt_snooze_longer()}</button
                      >
                    {/if}
                  </p>
                {/if}
                <div class="mt-1 flex flex-wrap items-center gap-3">
                  {#if fromModule}<WhyButton subject={{ subject: 'alert', alertId: r.id }} />{:else if !r.id.startsWith('live-')}<WhyButton subject={{ subject: 'card', cardId: r.id }} />{/if}
                  {#if r.rule && !muted}
                    {#if canSnooze}
                      <!-- One tap snoozes for an hour (undo toast); "Longer…" offers the other durations. -->
                      <button
                        type="button"
                        class="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onclick={() => snooze(r, '1h')}
                        data-testid="alert-snooze">{m.tt_snooze_1h()}</button
                      >
                      <button
                        type="button"
                        class="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        aria-expanded={snoozing === r.id}
                        onclick={() => (snoozing = snoozing === r.id ? null : r.id)}
                        data-testid="alert-snooze-more">{m.tt_snooze_longer()}</button
                      >
                    {/if}
                    {#if canMute}
                      <button type="button" class="text-xs text-muted-foreground underline-offset-2 hover:underline" onclick={() => mute(r)} data-testid="alert-mute">{m.act_alert_mute()}</button>
                    {/if}
                  {/if}
                </div>
                {#if snoozing === r.id}
                  <div class="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={m.act_alert_snooze()} data-testid="alert-snooze-options">
                    {#each SNOOZES as s (s.id)}
                      <button type="button" class="rounded-full border px-2.5 py-1 text-xs" onclick={() => snooze(r, s.id)} data-testid={`alert-snooze-${s.id}`}>{snoozeText[s.id]()}</button>
                    {/each}
                  </div>
                {/if}
                <ItemLens lines={[...(r.technical ? [r.technical] : []), ...(r.rule ? [`rule ${r.rule} · ${r.relayId ?? 'server-wide'} · ${r.id}`] : [])]} />
              </div>
              <span class="shrink-0 text-[11px] text-muted-foreground">{ago(r.at)}</span>
            </div>
          </SwipeRow>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
