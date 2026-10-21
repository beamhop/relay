<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { HealthStatus } from '$lib/api/types';

  let {
    score,
    status,
    size = 120,
    stroke = 10,
    label,
  }: { score: number; status: HealthStatus; size?: number; stroke?: number; label: string } = $props();

  const r = $derived((size - stroke) / 2);
  const c = $derived(2 * Math.PI * r);
  const offset = $derived(c * (1 - Math.max(0, Math.min(100, score)) / 100));
  const color = $derived(
    status === 'ok' ? 'var(--success)' : status === 'warn' ? 'var(--warning)' : 'var(--destructive)',
  );
</script>

<div class="relative" style:width={`${size}px`} style:height={`${size}px`} role="img" aria-label={label} data-testid="health-ring">
  <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="-rotate-90">
    <circle cx={size / 2} cy={size / 2} {r} fill="none" stroke="var(--muted)" stroke-width={stroke} />
    <circle
      cx={size / 2}
      cy={size / 2}
      {r}
      fill="none"
      stroke={color}
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-dasharray={c}
      stroke-dashoffset={offset}
      style="transition: stroke-dashoffset 600ms ease"
    />
  </svg>
  <div class="absolute inset-0 flex flex-col items-center justify-center">
    <span class="text-3xl font-semibold tabular-nums" data-testid="health-score">{Math.round(score)}</span>
  </div>
</div>
