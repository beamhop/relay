<script lang="ts">
  /** "2.1 GB of 5 GB · 2.9 GB left" with a bar; red and badged when over the limit. */
  import type { QuotaInfo } from './users';
  import { formatBytes, cn } from '$lib/utils';
  import Badge from '../ui/badge.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { q, compact = false }: { q: QuotaInfo; compact?: boolean } = $props();
</script>

<div class={cn('w-full', compact ? 'mt-1' : 'mt-1.5')} data-testid="quota" data-over={q.over}>
  <div class="flex items-center gap-2">
    <p class="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="quota-text">
      {q.over
        ? m.quota_line_over({ used: formatBytes(q.used), quota: formatBytes(q.quota), over: formatBytes(q.used - q.quota) })
        : m.quota_line({ used: formatBytes(q.used), quota: formatBytes(q.quota), left: formatBytes(q.left) })}
    </p>
    {#if q.over}<span class="shrink-0" data-testid="over-quota"><Badge tone="critical">{m.quota_over_badge()}</Badge></span>{/if}
  </div>
  <div
    class={cn('mt-1 h-1.5 overflow-hidden rounded-full bg-muted', compact && 'h-1')}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(q.fraction * 100)}
    aria-label={m.quota_bar_label()}
  >
    <div
      class={cn('h-full rounded-full', q.over ? 'bg-destructive' : q.fraction > 0.85 ? 'bg-warning' : 'bg-primary')}
      style:width={`${Math.max(2, q.fraction * 100)}%`}
    ></div>
  </div>
</div>
