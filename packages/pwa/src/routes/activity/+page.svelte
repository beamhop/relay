<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Activity (§6.1): live stream (with refused posts and multi-select),
   * moderation queue, recycle bin, team feed, alerts, errors & logs.
   */
  import { page } from '$app/state';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import { app } from '$lib/stores/app.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { FILTERS, describeLive, groupOf, type StreamFilter } from '$lib/describe';
  import { to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import VirtualList from '$lib/components/VirtualList.svelte';
  import ModerationQueue from '$lib/components/activity/ModerationQueue.svelte';
  import RecycleBin from '$lib/components/activity/RecycleBin.svelte';
  import TeamFeed from '$lib/components/activity/TeamFeed.svelte';
  // Alerts, logs and refused posts load on demand (keeps the first load of Activity small).
  const loadAlerts = () => import('$lib/components/activity/AlertsList.svelte');
  const loadLogs = () => import('$lib/components/activity/LogViewer.svelte');
  const loadRefused = () => import('$lib/components/activity/RefusedList.svelte');
  import BulkActions from '$lib/components/activity/BulkActions.svelte';
  import NotesButton from '$lib/components/notes/NotesButton.svelte';
  import { longpress } from '$lib/components/activity/longpress';
  import { type Pick, pickFromLive, selectRange } from '$lib/components/activity/bulk';
  import { m } from '$lib/paraglide/messages.js';

  const tab = $derived(page.url.searchParams.get('tab') ?? 'stream');
  let filter = $state<StreamFilter | 'refused'>('all');
  let search = $state('');

  const filterLabel: Record<StreamFilter, () => string> = {
    all: () => m.filter_all(),
    posts: () => m.filter_posts(),
    blocked: () => m.filter_blocked(),
    reports: () => m.filter_reports(),
    media: () => m.filter_media(),
    admin: () => m.filter_admin(),
    errors: () => m.filter_errors(),
  };

  const rows = $derived(
    live.items
      .filter((i) => i.name !== 'conn.open' && i.name !== 'conn.close')
      .filter((i) => filter === 'all' || groupOf(i.name) === filter)
      .map((i) => ({ item: i, d: describeLive(i), pick: pickFromLive(i.name, i.data) }))
      .filter((r) => !search || r.d.text.toLowerCase().includes(search.toLowerCase()) || (prefs.lens && r.d.technical.includes(search))),
  );

  /** Multi-select of posts in the stream (§6.13): long-press on phone, checkboxes / shift-click on desktop. */
  let selecting = $state(false);
  let selected = $state<Set<number>>(new Set());
  let anchor: string | null = null;
  const canModerate = $derived(app.can('moderation.write'));

  function toggleRow(seq: number, e?: MouseEvent) {
    selecting = true;
    const order = rows.filter((r) => r.pick).map((r) => String(r.item.seq));
    const next = selectRange(new Set([...selected].map(String)), order, anchor, String(seq), !!e?.shiftKey);
    selected = new Set([...next].map(Number));
    anchor = String(seq);
    live.paused = true;
  }
  function stopSelecting() {
    selecting = false;
    selected = new Set();
    anchor = null;
    live.paused = false;
  }
  const picks = $derived<Pick[]>(
    live.items.filter((i) => selected.has(i.seq)).map((i) => pickFromLive(i.name, i.data)).filter((p): p is Pick => !!p),
  );

  const moduleLinks = $derived(app.uiRoutes.filter((r) => r.placement === 'activity-section'));
  const tones = { ok: 'bg-success', warn: 'bg-warning', critical: 'bg-destructive', neutral: 'bg-muted-foreground/50' };
</script>

<svelte:head><title>{m.nav_activity()} · {m.app_name()}</title></svelte:head>

<h1 class="mb-3 text-xl font-semibold tracking-tight">{m.nav_activity()}</h1>
<Segmented
  label={m.nav_activity()}
  tabs={[
    { id: 'stream', label: m.activity_tab_stream() },
    { id: 'queue', label: m.activity_tab_queue() },
    { id: 'bin', label: m.activity_tab_bin() },
    { id: 'feed', label: m.activity_tab_feed() },
    { id: 'alerts', label: m.activity_tab_alerts() },
    { id: 'logs', label: m.act_tab_logs() },
  ]}
/>

<div class="mt-4">
  {#if tab === 'queue'}
    <ModerationQueue />
  {:else if tab === 'bin'}
    <RecycleBin />
  {:else if tab === 'feed'}
    <TeamFeed />
  {:else if tab === 'alerts'}
    {#await loadAlerts() then { default: AlertsList }}<AlertsList />{/await}
  {:else if tab === 'logs'}
    {#await loadLogs() then { default: LogViewer }}<LogViewer />{/await}
  {:else}
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <input
        type="search"
        placeholder={m.stream_search()}
        aria-label={m.stream_search()}
        class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
        bind:value={search}
      />
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm"
        aria-pressed={live.paused}
        onclick={() => (live.paused = !live.paused)}
      >
        {#if live.paused}<Play class="size-3.5" />{m.stream_resume()}{:else}<Pause class="size-3.5" />{m.stream_pause()}{/if}
      </button>
    </div>
    <div class="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label={m.stream_filter()}>
      {#each FILTERS as f (f)}
        <button
          class={cn('shrink-0 rounded-full border px-2.5 py-1 text-xs', filter === f ? 'border-foreground' : 'text-muted-foreground')}
          aria-pressed={filter === f}
          onclick={() => (filter = f)}
        >
          {filterLabel[f]()}
        </button>
      {/each}
      {#if app.hasAction('experience.recent-rejections')}
        <button
          class={cn('shrink-0 rounded-full border px-2.5 py-1 text-xs', filter === 'refused' ? 'border-foreground' : 'text-muted-foreground')}
          aria-pressed={filter === 'refused'}
          onclick={() => ((filter = 'refused'), stopSelecting())}
          data-testid="filter-refused"
        >
          {m.act_filter_refused()}
        </button>
      {/if}
    </div>
    {#if filter === 'refused'}
      {#await loadRefused() then { default: RefusedList }}<RefusedList />{/await}
    {:else}
    {#if selecting}
      <BulkActions {picks} kinds={['remove', 'ban']} oncancel={stopSelecting} ondone={(_k, pending) => !pending && stopSelecting()} />
    {/if}
    <p class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span class={cn('size-2 rounded-full', live.connected ? 'animate-pulse bg-success' : 'bg-muted-foreground/40')}></span>
      {live.connected ? m.stream_live() : m.stream_offline()}
      {#if canModerate && !selecting && rows.some((r) => r.pick)}<span class="ml-auto">{m.act_bulk_hint()}</span>{/if}
    </p>
    {#if rows.length === 0}
      <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="stream-empty">{m.stream_empty()}</p>
    {:else}
      <div class="rounded-xl border">
        <VirtualList items={rows} key={(r) => r.item.seq} rowHeight={prefs.lens ? 64 : 52} testid="stream" height="calc(100dvh - 22rem)">
          {#snippet row(r)}
            <div
              class={cn('flex h-full items-center gap-3 border-b px-3', selected.has(r.item.seq) && 'bg-primary/5')}
              use:longpress={{ onlongpress: () => toggleRow(r.item.seq), enabled: canModerate && !!r.pick }}
              data-testid="stream-row"
            >
              {#if canModerate && r.pick}
                <input
                  type="checkbox"
                  class={cn('size-4 shrink-0', !selecting && 'hidden md:block')}
                  checked={selected.has(r.item.seq)}
                  onclick={(e) => {
                    e.preventDefault();
                    toggleRow(r.item.seq, e);
                  }}
                  aria-label={m.common_select()}
                  data-testid="stream-check"
                />
              {/if}
              <span class={cn('size-2 shrink-0 rounded-full', tones[r.d.tone])}></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm">{r.d.text}</p>
                {#if prefs.lens}<p class="truncate font-mono text-[10px] text-muted-foreground">{r.item.name} · {r.d.technical}</p>{/if}
              </div>
              {#if r.pick?.eventId}<NotesButton subject={{ type: 'event', id: r.pick.eventId }} />{/if}
              <time class="shrink-0 text-[11px] text-muted-foreground tabular-nums">{new Date(r.item.at).toLocaleTimeString()}</time>
            </div>
          {/snippet}
        </VirtualList>
      </div>
    {/if}
    {/if}
  {/if}

  {#if moduleLinks.length}
    <ul class="mt-6 space-y-1">
      {#each moduleLinks as r (r.path)}
        <li><a class="text-sm text-primary" href={to(`/m${r.path}`)}>{r.title}</a></li>
      {/each}
    </ul>
  {/if}
</div>
