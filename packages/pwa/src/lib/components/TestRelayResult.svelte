<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** "Test my relay" result as a friendly checklist (technical details under the lens). */
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Minus from '@lucide/svelte/icons/minus';
  import Globe from '@lucide/svelte/icons/globe';
  import type { TestRelayReport } from '$lib/api/types';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import Button from './ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { report, onnavigate }: { report: TestRelayReport; onnavigate?: () => void } = $props();

  const icons = { pass: Check, fail: X, warn: TriangleAlert, skip: Minus };
  const tones = {
    pass: 'bg-success/15 text-success',
    fail: 'bg-destructive/15 text-destructive',
    warn: 'bg-warning/15 text-warning',
    skip: 'bg-muted text-muted-foreground',
  };
  const labels = {
    pass: () => m.test_step_pass(),
    fail: () => m.test_step_fail(),
    warn: () => m.test_step_warn(),
    skip: () => m.test_step_skip(),
  };
</script>

<div class="space-y-3" data-testid="test-relay-result" data-ok={report.ok}>
  {#if report.needsDomain}
    <div class="rounded-xl border border-warning/40 bg-warning/10 p-4" data-testid="test-needs-domain">
      <div class="flex items-center gap-2">
        <Globe class="size-4 text-warning" />
        <p class="text-sm font-medium">{m.test_needs_domain_title()}</p>
      </div>
      <p class="mt-1 text-sm text-muted-foreground">{report.summary || m.test_needs_domain_body()}</p>
      <Button size="sm" class="mt-3" href={to('/settings/domains')} onclick={() => onnavigate?.()} data-testid="test-open-domains">
        {m.test_open_domains()}
      </Button>
    </div>
  {:else}
    <p class={cn('text-sm font-medium', report.ok ? 'text-success' : 'text-destructive')} data-testid="test-summary">{report.summary}</p>
    <ul class="divide-y rounded-xl border">
      {#each report.steps ?? [] as s (s.id)}
        {@const Icon = icons[s.status] ?? Minus}
        <li class="flex items-start gap-3 p-3" data-step={s.id} data-status={s.status}>
          <span class={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', tones[s.status] ?? tones.skip)} aria-label={labels[s.status]?.() ?? s.status}>
            <Icon class="size-3" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{s.title}</p>
            <p class="text-xs text-muted-foreground">{s.message}</p>
            {#if prefs.lens && (s.technical || s.ms !== undefined)}
              <p class="mt-0.5 break-all font-mono text-[10px] text-muted-foreground" data-lens>
                {s.technical ?? ''}{s.ms !== undefined ? ` · ${s.ms} ms` : ''}
              </p>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
