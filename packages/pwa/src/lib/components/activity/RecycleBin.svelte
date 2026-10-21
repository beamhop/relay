<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Recycle bin (§6.11): removed posts and files, restorable until they are purged. */
  import { onMount } from 'svelte';
  import type { RecycleEntry } from '$lib/api/types';
  import { app } from '$lib/stores/app.svelte';
  import { runNow, asApiError } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { ago, short } from '$lib/utils';
  import Button from '../ui/button.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import NotesButton from '../notes/NotesButton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let items = $state<RecycleEntry[] | null>(null);
  let selected = $state<Set<string>>(new Set());
  let error = $state<string | null>(null);

  async function load() {
    try {
      const r = await app.api.run<{ items: RecycleEntry[] }>('moderation.recycle-bin', {});
      items = r.output.items;
      error = null;
    } catch (err) {
      error = asApiError(err).message;
      items = [];
    }
  }
  onMount(load);

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selected = s;
  }

  async function restore(ids: string[]) {
    const r = await runNow('moderation.restore', { ids }, { afterUndo: load });
    if (r) {
      selected = new Set();
      await load();
    }
  }

  const daysLeft = (e: RecycleEntry) => Math.max(0, Math.ceil((e.purgeAt * 1000 - Date.now()) / 86_400_000));
</script>

{#if items === null}
  <Skeleton class="h-40 w-full" />
{:else if error}
  <p class="text-sm text-destructive">{error}</p>
{:else if items.length === 0}
  <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{m.bin_empty()}</p>
{:else}
  <div class="mb-3 flex items-center justify-between">
    <p class="text-xs text-muted-foreground">{m.bin_note()}</p>
    {#if selected.size}
      <Button size="sm" onclick={() => restore([...selected])}>{m.bin_restore_n({ count: selected.size })}</Button>
    {/if}
  </div>
  <ul class="divide-y rounded-xl border" data-testid="recycle-bin">
    {#each items as e (e.id)}
      <li class="flex items-center gap-3 p-3">
        <input type="checkbox" class="size-4" checked={selected.has(e.id)} onchange={() => toggle(e.id)} aria-label={m.common_select()} />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm">{e.type === 'event' ? e.event?.content || m.mod_no_text() : m.bin_file({ id: short(e.id) })}</p>
          <p class="text-xs text-muted-foreground">
            {m.bin_removed({ when: ago(e.removedAt) })} · {m.bin_days_left({ count: daysLeft(e) })}{e.event ? ` · ${names.label(e.event.pubkey)}` : ''}{e.reason ? ` · ${names.text(e.reason)}` : ''}
          </p>
          {#if prefs.lens}<p class="font-mono text-[10px] text-muted-foreground">{e.id} · by {e.by}</p>{/if}
        </div>
        <NotesButton subject={{ type: e.type === 'event' ? 'event' : 'blob', id: e.event?.id ?? e.id }} />
        <Button size="sm" variant="secondary" onclick={() => restore([e.id])}>{m.bin_restore()}</Button>
      </li>
    {/each}
  </ul>
{/if}
