<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Activity (§6.1): live stream, moderation queue, recycle bin, team feed, alerts. */
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
  import AlertsList from '$lib/components/activity/AlertsList.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const tab = $derived(page.url.searchParams.get('tab') ?? 'stream');
  let filter = $state<StreamFilter>('all');
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
      .map((i) => ({ item: i, d: describeLive(i) }))
      .filter((r) => !search || r.d.text.toLowerCase().includes(search.toLowerCase()) || (prefs.lens && r.d.technical.includes(search))),
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
    <AlertsList />
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
    </div>
    <p class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span class={cn('size-2 rounded-full', live.connected ? 'animate-pulse bg-success' : 'bg-muted-foreground/40')}></span>
      {live.connected ? m.stream_live() : m.stream_offline()}
    </p>
    {#if rows.length === 0}
      <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="stream-empty">{m.stream_empty()}</p>
    {:else}
      <div class="rounded-xl border">
        <VirtualList items={rows} key={(r) => r.item.seq} rowHeight={prefs.lens ? 64 : 52} testid="stream" height="calc(100dvh - 22rem)">
          {#snippet row(r)}
            <div class="flex h-full items-center gap-3 border-b px-3">
              <span class={cn('size-2 shrink-0 rounded-full', tones[r.d.tone])}></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm">{r.d.text}</p>
                {#if prefs.lens}<p class="truncate font-mono text-[10px] text-muted-foreground">{r.item.name} · {r.d.technical}</p>{/if}
              </div>
              <time class="shrink-0 text-[11px] text-muted-foreground tabular-nums">{new Date(r.item.at).toLocaleTimeString()}</time>
            </div>
          {/snippet}
        </VirtualList>
      </div>
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
