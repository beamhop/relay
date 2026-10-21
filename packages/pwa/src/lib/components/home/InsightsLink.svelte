<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Small header link from a tab to the matching part of the Insights screen. */
  import ChartLine from '@lucide/svelte/icons/chart-line';
  import { app } from '$lib/stores/app.svelte';
  import { to } from '$lib/nav';
  import { m } from '$lib/paraglide/messages.js';

  let { section = 'live' }: { section?: 'live' | 'storage' | 'community' } = $props();
</script>

{#if app.hasAction('insights.overview')}
  <a
    href={to(`/insights#${section}`)}
    class="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
    data-testid="insights-link"
  >
    <ChartLine class="size-3.5" />{m.insights_open()}
  </a>
{/if}
