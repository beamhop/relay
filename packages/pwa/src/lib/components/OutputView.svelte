<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Human view of read-only action output (§6.6): labelled rows, compact cards
   * for lists, formatted sizes/times, people by name, short ids with copy.
   * Raw JSON lives only behind the technical lens (ActionSheet).
   */
  import Copy from '@lucide/svelte/icons/copy';
  import Self from './OutputView.svelte';
  import { names } from '$lib/stores/names.svelte';
  import {
    type Cell,
    PAGE,
    entriesOf,
    formatValue,
    humanizeKey,
    isPlainObject,
    itemTitle,
    titleKey,
  } from '$lib/output';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    value,
    field = undefined,
    depth = 0,
    skip = undefined,
  }: { value: unknown; field?: string; depth?: number; skip?: string } = $props();

  let shown = $state(PAGE);

  const isScalar = (v: unknown) => v === null || typeof v !== 'object';
  const isScalarList = (v: unknown) => Array.isArray(v) && v.every(isScalar);
  const cell = (k: string | undefined, v: unknown): Cell => formatValue(k, v, names);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show({ message: m.common_copied(), kind: 'info' });
    } catch {
      toasts.error(m.common_copy_failed());
    }
  }
</script>

{#snippet leaf(c: Cell)}
  {#if c.kind === 'person'}
    <span class="inline-flex items-center gap-1" data-person>
      {c.text}
      <button type="button" class="text-muted-foreground hover:text-foreground" aria-label={m.out_copy_key()} onclick={() => copy(c.pubkey)}>
        <Copy class="size-3" />
      </button>
    </span>
  {:else if c.kind === 'id'}
    <span class="inline-flex items-center gap-1" data-id>
      {c.text}
      <button type="button" class="text-muted-foreground hover:text-foreground" aria-label={m.out_copy_id()} onclick={() => copy(c.full)}>
        <Copy class="size-3" />
      </button>
    </span>
  {:else if c.kind === 'empty'}
    <span class="text-muted-foreground">{c.text}</span>
  {:else}
    <span class="break-words">{c.text}</span>
  {/if}
{/snippet}

{#snippet more(total: number)}
  {#if total > shown}
    <button type="button" class="mt-2 w-full rounded-lg border py-2 text-xs text-primary" onclick={() => (shown += PAGE)}>
      {m.out_show_more({ count: Math.min(PAGE, total - shown) })}
    </button>
  {/if}
{/snippet}

{#if depth > 4}
  <span class="text-muted-foreground">…</span>
{:else if isScalar(value)}
  {@render leaf(cell(field, value))}
{:else if Array.isArray(value)}
  {#if value.length === 0}
    <span class="text-muted-foreground">{m.out_none()}</span>
  {:else if isScalarList(value)}
    <span class="inline-flex flex-wrap gap-x-2 gap-y-1">
      {#each value.slice(0, shown) as v, i (i)}
        <span>{@render leaf(cell(field, v))}{i < Math.min(shown, value.length) - 1 ? ',' : ''}</span>
      {/each}
    </span>
    {@render more(value.length)}
  {:else}
    <ul class="space-y-2" data-output-list>
      {#each value.slice(0, shown) as item, i (i)}
        <li class="rounded-lg border p-2.5">
          {#if isPlainObject(item)}
            {@const title = itemTitle(item, names)}
            {#if title}<p class="mb-1 text-sm font-medium">{title}</p>{/if}
            <Self value={item} depth={depth + 1} skip={titleKey(item)} />
          {:else}
            <Self value={item} field={field} depth={depth + 1} />
          {/if}
        </li>
      {/each}
    </ul>
    {@render more(value.length)}
  {/if}
{:else if isPlainObject(value)}
  {@const rows = entriesOf(value).filter(([k]) => k !== skip)}
  {#if rows.length === 0}
    {#if depth === 0}<p class="text-sm text-muted-foreground">{m.out_empty()}</p>{/if}
  {:else}
    <dl class="space-y-1.5 text-sm">
      {#each rows as [k, v] (k)}
        {#if isScalar(v) || isScalarList(v)}
          <div class="flex gap-3">
            <dt class="w-2/5 shrink-0 text-muted-foreground">{humanizeKey(k)}</dt>
            <dd class="min-w-0 flex-1"><Self value={v} field={k} depth={depth + 1} /></dd>
          </div>
        {:else}
          <div>
            <dt class="mt-2 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{humanizeKey(k)}</dt>
            <dd><Self value={v} field={k} depth={depth + 1} /></dd>
          </div>
        {/if}
      {/each}
    </dl>
  {/if}
{/if}
