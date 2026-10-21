<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** One line about the clean-up of files nobody uses any more (orphan GC). */
  import { onMount } from 'svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import { ago, formatBytes } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import { type CleanupStatus, until } from './media';

  let s = $state<CleanupStatus | null>(null);
  onMount(async () => {
    s = await query<CleanupStatus>('media.cleanup-status');
  });
  const next = $derived(s?.nextRun ? until(s.nextRun) : null);
</script>

{#if s}
  <div class="mb-4 text-xs text-muted-foreground" data-testid="cleanup-status">
    <p>
      {s.lastRun ? m.media_cleanup_line({ when: ago(s.lastRun), size: formatBytes(s.freedBytes) }) : m.media_cleanup_never()}
      · {m.media_cleanup_next({ when: next ? m.media_in({ when: next }) : m.media_soon() })}
      {#if s.orphans}· {m.media_cleanup_waiting({ count: s.orphans })}{/if}
    </p>
    <ItemLens
      lines={[
        `blossom.gc: erased ${s.erased}, expired ${s.expired}, scanned ${s.scanned}`,
        `orphans kept (legal hold) ${s.orphans}, total freed ${s.totalFreedBytes} B`,
      ]}
    />
  </div>
{/if}
