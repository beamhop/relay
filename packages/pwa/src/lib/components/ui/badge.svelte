<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  type Tone = 'neutral' | 'ok' | 'warn' | 'critical' | 'accent';
  let { tone = 'neutral', class: klass = '', children }: { tone?: Tone; class?: string; children?: Snippet } =
    $props();

  const tones: Record<Tone, string> = {
    neutral: 'bg-muted text-muted-foreground',
    ok: 'bg-success/15 text-success',
    warn: 'bg-warning/15 text-warning',
    critical: 'bg-destructive/15 text-destructive',
    accent: 'bg-accent text-accent-foreground',
  };
</script>

<span class={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', tones[tone], klass)}>
  {@render children?.()}
</span>
