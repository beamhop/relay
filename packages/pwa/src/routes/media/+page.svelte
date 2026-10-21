<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Media (§6.1): file grid with a detail sheet (lens, team notes), quarantined
   * items (release / delete for good), per-person usage and quotas, storage
   * tiers and cleanup status; multi-select bulk delete.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import FileIcon from '@lucide/svelte/icons/file';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import List from '@lucide/svelte/icons/list';
  import Check from '@lucide/svelte/icons/check';
  import { app } from '$lib/stores/app.svelte';
  import { announce, asApiError, flow, query, runNow } from '$lib/stores/actions.svelte';
  import { quotaOf } from '$lib/components/people/users';
  import QuotaBar from '$lib/components/people/QuotaBar.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { BlobItem, RelayConfig, UsageSummary } from '$lib/api/types';
  import { ago, cn, formatBytes } from '$lib/utils';
  import { names } from '$lib/stores/names.svelte';
  import { to } from '$lib/nav';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import SwipeRow from '$lib/components/SwipeRow.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import StorageTiersCard from '$lib/components/media/StorageTiersCard.svelte';
  import CleanupStatus from '$lib/components/media/CleanupStatus.svelte';
  import QuarantineList from '$lib/components/media/QuarantineList.svelte';
  import FileSheet from '$lib/components/media/FileSheet.svelte';
  import { type MediaFile, fileLensLines } from '$lib/components/media/media';
  import { m } from '$lib/paraglide/messages.js';

  const tab = $derived(page.url.searchParams.get('tab') ?? 'files');
  let blobs = $state<BlobItem[] | null>(null);
  let cursor = $state<string | undefined>();
  let error = $state<string | null>(null);
  let selecting = $state(false);
  let selected = $state<Set<string>>(new Set());
  let view = $state<'grid' | 'list'>('grid');
  let relayCfg = $state<RelayConfig | null>(null);
  let summary = $state<UsageSummary | null>(null);
  let detail = $state<MediaFile | null>(null);
  let quarantineCount = $state<number | null>(null);
  const reviewQueue = $derived(app.hasAction('media.list-quarantine'));

  async function load(more = false) {
    try {
      const r = await app.api.run<{ items: BlobItem[]; cursor?: string }>('media.list-blobs', {
        limit: 120,
        ...(more && cursor ? { cursor } : {}),
      });
      blobs = more ? [...(blobs ?? []), ...r.output.items] : r.output.items;
      cursor = r.output.cursor;
      error = null;
    } catch (err) {
      error = asApiError(err).message;
      blobs ??= [];
    }
    relayCfg = (await app.api.relayConfig().catch(() => null))?.relay ?? relayCfg;
    if (!more) {
      summary = await query<UsageSummary>('media.usage-summary');
      if (reviewQueue) {
        const q = await query<{ items: unknown[] }>('media.list-quarantine', { limit: 100 });
        quarantineCount = q?.items.length ?? null;
      }
    }
  }
  onMount(() => load());

  const key = (b: BlobItem) => `${b.sha256}:${b.pubkey}`;
  const files = $derived((blobs ?? []).filter((b) => (tab === 'quarantine' ? b.quarantined : !b.quarantined)) as MediaFile[]);
  const usage = $derived.by(() => {
    const per = new Map<string, { pubkey: string; bytes: number; files: number }>();
    for (const b of blobs ?? []) {
      const u = per.get(b.pubkey) ?? { pubkey: b.pubkey, bytes: 0, files: 0 };
      u.bytes += b.size ?? 0;
      u.files++;
      per.set(b.pubkey, u);
    }
    return [...per.values()].sort((a, b) => b.bytes - a.bytes);
  });
  const total = $derived((blobs ?? []).reduce((a, b) => a + (b.size ?? 0), 0));

  function toggle(b: BlobItem) {
    const s = new Set(selected);
    if (s.has(key(b))) s.delete(key(b));
    else s.add(key(b));
    selected = s;
  }

  async function deleteSelected() {
    const items = (blobs ?? []).filter((b) => selected.has(key(b)));
    if (!items.length) return;
    try {
      const r = await app.api.bulk(
        'media.delete-blob',
        items.map((b) => ({ sha256: b.sha256, pubkey: b.pubkey })),
      );
      announce(r, () => load());
      selected = new Set();
      selecting = false;
      await load();
    } catch (err) {
      const e = asApiError(err);
      toasts.error(e.message, e.technical);
    }
  }

  async function deleteOne(b: BlobItem) {
    const r = await runNow('media.delete-blob', { sha256: b.sha256, pubkey: b.pubkey }, { afterUndo: () => load() });
    if (r) await load();
  }

  function openFile(b: MediaFile) {
    if (selecting) toggle(b);
    else detail = b;
  }

  const isImage = (b: BlobItem) => (b.type ?? '').startsWith('image/');
  const src = (b: MediaFile) => b.thumbUrl ?? b.url ?? `/${b.sha256}`;
  const quota = $derived(relayCfg?.blossom?.defaultQuotaBytes);
</script>

<svelte:head><title>{m.nav_media()} · {m.app_name()}</title></svelte:head>

<div class="mb-3 flex items-center justify-between gap-2">
  <h1 class="text-xl font-semibold tracking-tight">{m.nav_media()}</h1>
  {#if tab === 'files' || tab === 'quarantine'}
    <div class="flex gap-1">
      <Button size="sm" variant="ghost" aria-label={m.media_view_toggle()} onclick={() => (view = view === 'grid' ? 'list' : 'grid')}>
        {#if view === 'grid'}<List class="size-4" />{:else}<LayoutGrid class="size-4" />{/if}
      </Button>
      {#if app.can('media.write')}
        <Button size="sm" variant={selecting ? 'default' : 'secondary'} onclick={() => ((selecting = !selecting), (selected = new Set()))} data-testid="media-select">
          {selecting ? m.common_done() : m.common_select()}
        </Button>
      {/if}
    </div>
  {/if}
</div>

<Segmented
  label={m.nav_media()}
  tabs={[
    { id: 'files', label: m.media_tab_files() },
    { id: 'quarantine', label: m.media_tab_quarantine(), count: quarantineCount ?? (blobs ?? []).filter((b) => b.quarantined).length },
    { id: 'usage', label: m.media_tab_usage() },
  ]}
/>

<div class="mt-4">
  {#if error}<p class="mb-3 text-sm text-destructive">{error}</p>{/if}
  <PullToRefresh onrefresh={() => load()}>
    {#if blobs === null}
      <div class="grid grid-cols-3 gap-2 md:grid-cols-6">{#each Array(9) as _, i (i)}<Skeleton class="aspect-square" />{/each}</div>
    {:else if tab === 'quarantine' && reviewQueue}
      <QuarantineList oncount={(n) => (quarantineCount = n)} />
    {:else if tab === 'usage'}
      {#if app.hasAction('media.storage-tiers')}<StorageTiersCard />{/if}
      {#if app.hasAction('media.cleanup-status')}<CleanupStatus />{/if}
      {#if summary}
        <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="usage-summary">
          <div class="rounded-xl border p-3">
            <p class="text-xs text-muted-foreground">{m.media_total()}</p>
            <p class="text-lg font-semibold" data-testid="usage-total">{formatBytes(summary.totalUsedBytes)}</p>
          </div>
          <div class="rounded-xl border p-3">
            <p class="text-xs text-muted-foreground">{m.media_people()}</p>
            <p class="text-lg font-semibold">{summary.people}</p>
          </div>
          <div class="rounded-xl border p-3">
            <p class="text-xs text-muted-foreground">{m.media_near_quota()}</p>
            <p class={cn('text-lg font-semibold', summary.nearQuota > 0 && 'text-warning')} data-testid="usage-near">{summary.nearQuota}</p>
          </div>
          <div class="rounded-xl border p-3">
            <p class="text-xs text-muted-foreground">{m.media_over_quota()}</p>
            <p class={cn('text-lg font-semibold', summary.overQuota > 0 && 'text-destructive')} data-testid="usage-over">{summary.overQuota}</p>
          </div>
        </div>
        <a href={to('/settings/media')} class="mb-4 block text-right text-xs text-primary">
          {m.media_default_quota()}: {quota !== undefined ? formatBytes(quota) : m.media_quota_tier()}
        </a>
        <h2 class="mb-2 text-sm font-medium">{m.media_largest()}</h2>
        <ul class="divide-y rounded-xl border" data-testid="usage-largest">
          {#each summary.largest as u (u.pubkey)}
            {@const q = quotaOf(u)}
            <li class="flex items-center gap-3 p-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm">{names.label(u.pubkey)}</span>
                  {#if !q}<span class="text-sm tabular-nums">{formatBytes(u.usedBytes)}</span>{/if}
                </div>
                {#if q}<QuotaBar {q} compact />{/if}
              </div>
              {#if app.hasAction('media.set-quota') && app.can('media.write')}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    const def = app.action('media.set-quota');
                    if (def) void flow.start(def, { pubkey: u.pubkey, quotaBytes: null }, { form: true });
                  }}>{m.media_set_quota()}</Button
                >
              {/if}
            </li>
          {:else}
            <li class="p-6 text-center text-sm text-muted-foreground">{m.media_empty()}</li>
          {/each}
        </ul>
      {:else}
      <div class="mb-4 grid grid-cols-2 gap-3">
        <div class="rounded-xl border p-3">
          <p class="text-xs text-muted-foreground">{m.media_total()}</p>
          <p class="text-lg font-semibold">{formatBytes(total)}{cursor ? '+' : ''}</p>
        </div>
        <a href={to('/settings/media')} class="rounded-xl border p-3">
          <p class="text-xs text-muted-foreground">{m.media_default_quota()}</p>
          <p class="text-lg font-semibold">{quota !== undefined ? formatBytes(quota) : m.media_quota_tier()}</p>
        </a>
      </div>
      <ul class="divide-y rounded-xl border" data-testid="usage-list">
        {#each usage as u (u.pubkey)}
          <li class="flex items-center gap-3 p-3">
            <span class="min-w-0 flex-1 truncate text-sm">{names.label(u.pubkey)}</span>
            <span class="text-xs text-muted-foreground">{m.media_files_count({ count: u.files })}</span>
            <span class="w-20 text-right text-sm tabular-nums">{formatBytes(u.bytes)}</span>
            {#if app.hasAction('media.set-quota') && app.can('media.write')}
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  const def = app.action('media.set-quota');
                  if (def) void flow.start(def, { pubkey: u.pubkey, quotaBytes: null }, { form: true });
                }}>{m.media_set_quota()}</Button
              >
            {/if}
          </li>
        {:else}
          <li class="p-6 text-center text-sm text-muted-foreground">{m.media_empty()}</li>
        {/each}
      </ul>
      {/if}
    {:else if files.length === 0}
      <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        {#if tab === 'quarantine'}<ShieldAlert class="size-6" />{m.media_quarantine_empty()}{:else}<FileIcon class="size-6" />{m.media_empty()}{/if}
      </div>
    {:else if view === 'grid'}
      <ul class="grid grid-cols-3 gap-2 md:grid-cols-6" data-testid="media-grid">
        {#each files as b (key(b))}
          <li class="relative">
            <button
              class={cn('group relative block aspect-square w-full overflow-hidden rounded-lg border bg-muted', selected.has(key(b)) && 'ring-2 ring-primary')}
              onclick={() => openFile(b)}
              data-testid="media-tile"
              aria-pressed={selecting ? selected.has(key(b)) : undefined}
              aria-label={`${b.type ?? ''} ${formatBytes(b.size)}`}
            >
              {#if isImage(b) && !b.quarantined}
                <img src={src(b)} alt="" loading="lazy" class="h-full w-full object-cover" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
              {:else}
                <span class="flex h-full w-full flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground">
                  {#if b.quarantined}<ShieldAlert class="size-5 text-destructive" />{:else}<FileIcon class="size-5" />{/if}
                  {b.type ?? ''}
                </span>
              {/if}
              <span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-4 pb-1 text-left text-[10px] text-white">{formatBytes(b.size)}</span>
              {#if selecting}
                <span class={cn('absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full border-2 border-white', selected.has(key(b)) ? 'bg-primary' : 'bg-black/30')}>
                  {#if selected.has(key(b))}<Check class="size-3 text-white" />{/if}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <ul class="divide-y overflow-hidden rounded-xl border" data-testid="media-list">
        {#each files as b (key(b))}
          <li>
            <SwipeRow right={app.can('media.write') ? [{ id: 'delete', label: m.common_delete(), tone: 'critical', run: () => deleteOne(b) }] : []}>
              <div class="flex items-center gap-3 p-3">
                {#if selecting}<input type="checkbox" class="size-4" checked={selected.has(key(b))} onchange={() => toggle(b)} aria-label={m.common_select()} />{/if}
                <div class="min-w-0 flex-1">
                  <button type="button" class="block w-full text-left" onclick={() => openFile(b)} data-testid="media-row">
                    <p class="truncate text-sm">{b.type ?? m.media_file()} · {formatBytes(b.size)}</p>
                    <p class="text-xs text-muted-foreground">{names.label(b.pubkey)} · {b.uploadedAt ? ago(b.uploadedAt) : ''}</p>
                  </button>
                  <ItemLens lines={fileLensLines(b)} />
                </div>
                {#if b.quarantined}<Badge tone="critical">{m.media_quarantined()}</Badge>{/if}
              </div>
            </SwipeRow>
          </li>
        {/each}
      </ul>
    {/if}
    {#if cursor && tab !== 'usage'}
      <Button variant="secondary" class="mt-4 w-full" onclick={() => load(true)}>{m.common_load_more()}</Button>
    {/if}
  </PullToRefresh>
</div>

{#if selecting && selected.size}
  <div class="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4 md:bottom-6">
    <div class="flex items-center gap-3 rounded-xl border bg-card px-4 py-2 shadow-xl">
      <span class="text-sm">{m.media_selected({ count: selected.size })}</span>
      <Button size="sm" variant="destructive" onclick={deleteSelected} data-testid="media-delete-selected">{m.common_delete()}</Button>
    </div>
  </div>
{/if}

<FileSheet
  bind:file={detail}
  ondelete={(f) => {
    detail = null;
    void deleteOne(f);
  }}
/>
