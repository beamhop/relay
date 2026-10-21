<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Quarantined files (§5.3, §6.1). Swipe right or tap Release to release (undo toast;
   * abuse-list matches are previewed first), swipe
   * left to delete for good (always previewed: it cannot be undone). The same
   * actions are buttons on each row. Abuse-list matches show only metadata.
   */
  import { onMount } from 'svelte';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import SwipeRow from '$lib/components/SwipeRow.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query, runNow } from '$lib/stores/actions.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { ago, formatBytes } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import QuarantineThumb from './QuarantineThumb.svelte';
  import type { QuarantineItem } from './media';

  let { oncount }: { oncount?: (n: number) => void } = $props();
  let items = $state<QuarantineItem[] | null>(null);

  async function load() {
    const r = await query<{ items: QuarantineItem[] }>('media.list-quarantine', { limit: 100 });
    items = r?.items ?? [];
    oncount?.(items.length);
  }
  onMount(load);

  const canAct = $derived(app.can('moderation.write'));

  function drop(sha: string) {
    items = (items ?? []).filter((i) => i.sha256 !== sha);
    oncount?.(items.length);
  }

  async function releaseNow(i: QuarantineItem) {
    const r = await runNow('media.release-quarantine', { sha256: i.sha256 }, { afterUndo: () => void load() });
    if (r) drop(i.sha256);
  }

  function start(id: 'media.release-quarantine' | 'media.confirm-quarantine', i: QuarantineItem) {
    const def = app.action(id);
    if (!def) return;
    void flow.start(def, { sha256: i.sha256 }, { onDone: () => drop(i.sha256), onUndo: () => void load() });
  }

  /**
   * Release is undoable (undo puts the file back on hold), so it runs at once with an
   * undo toast (§6.2). Abuse-list matches keep the preview: releasing one needs a look first.
   */
  function release(i: QuarantineItem) {
    if (i.abuse) start('media.release-quarantine', i);
    else void releaseNow(i);
  }

  const reason = (i: QuarantineItem) =>
    i.abuse ? m.media_q_abuse() : i.source === 'rule' ? `${m.media_q_rule()}: ${i.reason}` : i.reason || m.media_q_other();
</script>

{#if items === null}
  <div class="space-y-2">{#each Array(3) as _, k (k)}<Skeleton class="h-20" />{/each}</div>
{:else if items.length === 0}
  <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
    <ShieldAlert class="size-6" />{m.media_quarantine_empty()}
  </div>
{:else}
  <ul class="divide-y overflow-hidden rounded-xl border" data-testid="quarantine-list">
    {#each items as i (i.sha256)}
      <li data-testid="q-row" data-abuse={i.abuse}>
        <SwipeRow
          left={canAct ? [{ id: 'release', label: m.media_q_release(), tone: 'accent', run: () => release(i) }] : []}
          right={canAct ? [{ id: 'confirm', label: m.media_q_delete(), tone: 'critical', run: () => start('media.confirm-quarantine', i) }] : []}
        >
          <div class="flex gap-3 p-3">
            <QuarantineThumb item={i} />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                {#if i.abuse}<Badge tone="critical">{m.media_q_abuse()}</Badge>{:else}<Badge tone="warn">{m.media_quarantined()}</Badge>{/if}
                <span class="text-xs text-muted-foreground">{i.size !== null ? formatBytes(i.size) : ''} · {ago(i.at)}</span>
              </div>
              <p class="mt-1 truncate text-sm" data-testid="q-reason">{reason(i)}</p>
              {#if i.uploader}
                <p class="truncate text-xs text-muted-foreground">{m.media_q_uploader({ name: names.label(i.uploader) })}</p>
              {/if}
              <ItemLens lines={[`sha256 ${i.sha256}`, `mime ${i.type ?? 'unknown'}`, `uploads on this relay ${i.uploaders}`, i.technical]} />
              {#if canAct}
                <div class="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" onclick={() => release(i)} data-testid="q-release">{m.media_q_release()}</Button>
                  <Button size="sm" variant="destructive" onclick={() => start('media.confirm-quarantine', i)} data-testid="q-confirm">{m.media_q_delete()}</Button>
                </div>
              {/if}
            </div>
          </div>
        </SwipeRow>
      </li>
    {/each}
  </ul>
{/if}
