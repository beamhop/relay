<script lang="ts">
  /**
   * Alerts: open and recent alerts from the alerts module when it is installed (`alerts.list`),
   * otherwise the current warnings and recent errors.
   */
  import { onMount } from 'svelte';
  import BellRing from '@lucide/svelte/icons/bell-ring';
  import type { AttentionCard } from '$lib/api/types';
  import { app } from '$lib/stores/app.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { ago } from '$lib/utils';
  import { to } from '$lib/nav';
  import Badge from '../ui/badge.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  interface AlertRow {
    id: string;
    at: number;
    title: string;
    body?: string;
    severity: 'info' | 'warning' | 'critical';
    technical?: string;
    resolved?: boolean;
  }

  let rows = $state<AlertRow[] | null>(null);
  let fromModule = $state(false);

  onMount(async () => {
    type Rec = { id: string; lastAt: number; title: string; body: string; severity: 'warning' | 'critical'; technical?: string; resolvedAt?: number };
    const listed = await query<{ active: Rec[]; recent: Rec[] }>('alerts.list');
    if (listed) {
      fromModule = true;
      const seen = new Set<string>();
      rows = [...listed.active, ...listed.recent]
        .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
        .map((a) => {
          const r: AlertRow = { id: a.id, at: a.resolvedAt ?? a.lastAt, title: a.title, body: a.body, severity: a.severity };
          if (a.resolvedAt) r.resolved = true;
          if (a.technical) r.technical = a.technical;
          return r;
        });
      return;
    }
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
</script>

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
    <ul class="divide-y rounded-xl border" data-testid="alerts-list">
      {#each rows as r (r.id)}
        <li class="flex gap-3 p-3">
          <Badge tone={r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warn' : 'neutral'}>
            {r.severity === 'critical' ? m.severity_critical() : r.severity === 'warning' ? m.severity_warning() : m.severity_info()}
          </Badge>
          <div class="min-w-0 flex-1">
            <p class="text-sm">{r.title}</p>
            {#if r.body}<p class="text-xs text-muted-foreground">{r.body}</p>{/if}
            {#if r.resolved}<p class="text-xs text-success">{m.alerts_resolved()}</p>{/if}
            {#if prefs.lens && r.technical}<p class="font-mono text-[10px] text-muted-foreground">{r.technical}</p>{/if}
          </div>
          <span class="shrink-0 text-[11px] text-muted-foreground">{ago(r.at)}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
