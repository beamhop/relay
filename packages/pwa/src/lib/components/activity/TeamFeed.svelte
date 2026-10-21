<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Who-did-what feed (§6.12), linked to the audit log. */
  import { onMount } from 'svelte';
  import type { ActivityItem } from '$lib/api/types';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { ago } from '$lib/utils';
  import { names } from '$lib/stores/names.svelte';
  import Button from '../ui/button.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let items = $state<ActivityItem[] | null>(null);
  let cursor = $state<string | undefined>(undefined);
  let error = $state<string | null>(null);

  async function load(more = false) {
    try {
      const r = await app.api.activity({ limit: 50, ...(more && cursor ? { cursor } : {}) });
      items = more ? [...(items ?? []), ...r.items] : r.items;
      cursor = r.cursor;
      error = null;
    } catch (err) {
      error = asApiError(err).message;
      items ??= [];
    }
  }
  onMount(() => load());

  let lastTick = live.tick;
  $effect(() => {
    if (live.tick !== lastTick) {
      lastTick = live.tick;
      void load();
    }
  });
</script>

{#if items === null}
  <Skeleton class="h-40 w-full" />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if items.length === 0}
  <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{m.feed_empty()}</p>
{:else}
  <ol class="space-y-3" data-testid="team-feed">
    {#each items as i (i.seq)}
      <li class="flex gap-3 text-sm">
        <span class="mt-1.5 size-2 shrink-0 rounded-full {i.ok ? 'bg-primary' : 'bg-destructive'}"></span>
        <div class="min-w-0 flex-1">
          <p>{names.text(i.text)}</p>
          <p class="text-xs text-muted-foreground">
            {ago(i.at)}{i.relayId && app.relays.length > 1 ? ` · ${i.relayId}` : ''}
            {#if prefs.lens}<span class="font-mono"> · {i.actionId} · #{i.seq}</span>{/if}
          </p>
        </div>
      </li>
    {/each}
  </ol>
  {#if cursor}
    <Button variant="secondary" class="mt-4 w-full" onclick={() => load(true)}>{m.common_load_more()}</Button>
  {/if}
{/if}
