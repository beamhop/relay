<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Live ops (§8): connections, posts, let-in vs refused by reason, response
   * times, problems and storage — every number with "Why?" and its technical
   * name in the lens.
   */
  import Stat from '$lib/components/home/Stat.svelte';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { barWidth, type LiveHistory, type LiveOps } from '$lib/insights';
  import { formatBytes } from '$lib/utils';
  import LazyChart from './LazyChart.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    ops,
    history,
    hour,
    connected,
  }: {
    ops: LiveOps;
    history: LiveHistory;
    hour: { events: number[]; p95: number[]; errors: number[] };
    connected: boolean;
  } = $props();

  const REASON: Record<string, () => string> = {
    duplicate: () => m.insights_reason_duplicate(),
    pow: () => m.insights_reason_pow(),
    blocked: () => m.insights_reason_blocked(),
    'rate-limited': () => m.insights_reason_rate_limited(),
    invalid: () => m.insights_reason_invalid(),
    restricted: () => m.insights_reason_restricted(),
    mute: () => m.insights_reason_mute(),
    error: () => m.insights_reason_error(),
    'auth-required': () => m.insights_reason_auth_required(),
    spam: () => m.insights_reason_spam(),
    other: () => m.insights_reason_other(),
  };
  const reasonLabel = (r: string) => (REASON[r] ?? REASON.other!)();
  const n = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
  const maxReason = $derived(Math.max(0, ...ops.reasons.map((r) => r.perSecond)));
  /** Live points beat the stored hour once there are enough of them. */
  const pick = (live: number[], stored: number[]) => (stored.length > 1 ? stored : live);
</script>

<section id="live" aria-labelledby="live-title" class="scroll-mt-20 space-y-3" data-testid="insights-live">
  <div class="flex items-center justify-between">
    <h2 id="live-title" class="text-sm font-medium">{m.insights_live_title()}</h2>
    <span class="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="insights-live-state" data-live={connected}>
      <span class="size-2 rounded-full {connected ? 'animate-pulse bg-success' : 'bg-muted-foreground/40'}"></span>
      {connected ? m.insights_live_on() : m.insights_live_off()}
    </span>
  </div>

  <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
    <Stat testid="stat-connections" label={m.insights_connections()} value={n(ops.connections)} why={{ subject: 'metric', metric: 'connections', value: ops.connections }} lens={['gauge connections']} />
    <Stat testid="stat-events" label={m.insights_events()} value={n(ops.eventsPerSecond)} why={{ subject: 'metric', metric: 'events.accepted', value: ops.eventsPerSecond }} lens={['rate(events.accepted) /s, 60 s']} />
    <Stat testid="stat-accept" label={m.insights_accept()} value={pct(ops.acceptRatio)} why={{ subject: 'metric', metric: 'accept-ratio', value: ops.acceptRatio }} lens={['accepted / (accepted + rejected), 60 s']} />
    <Stat testid="stat-reads" label={m.insights_reads()} value={n(ops.reqPerSecond)} why={{ subject: 'metric', metric: 'req.served', value: ops.reqPerSecond }} lens={['rate(req.served) /s (REQ)']} />
    <Stat testid="stat-p50" label={m.insights_p50()} value={n(ops.p50Ms, ' ms')} why={ops.p50Ms === null ? { subject: 'metric', metric: 'latency.p50' } : { subject: 'metric', metric: 'latency.p50', value: ops.p50Ms }} lens={['event.latency p50, 5 min']} />
    <Stat testid="stat-p95" label={m.insights_p95()} value={n(ops.p95Ms, ' ms')} why={ops.p95Ms === null ? { subject: 'metric', metric: 'latency.p95' } : { subject: 'metric', metric: 'latency.p95', value: ops.p95Ms }} lens={['event.latency p95, 5 min']} />
    <Stat testid="stat-errors" label={m.insights_errors()} value={n(ops.errorsPerMinute)} why={{ subject: 'metric', metric: 'errors', value: ops.errorsPerMinute }} lens={['rate(errors) × 60']} />
    <Stat testid="stat-error-rate" label={m.insights_error_rate()} value={pct(ops.errorRate)} why={ops.errorRate === null ? { subject: 'metric', metric: 'error-rate' } : { subject: 'metric', metric: 'error-rate', value: ops.errorRate }} lens={['errors / (accepted + rejected + REQ)']} />
  </div>

  <div class="rounded-xl border bg-card p-4" data-testid="insights-reasons">
    <div class="flex items-baseline justify-between gap-2">
      <h3 class="text-sm font-medium">{m.insights_reasons_title()}</h3>
      <WhyButton subject={{ subject: 'metric', metric: 'events.rejected', value: ops.rejectedPerSecond }} />
    </div>
    <p class="mt-1 text-xs text-muted-foreground">{m.insights_reasons_let_in({ percent: Math.round(ops.acceptRatio * 1000) / 10 })}</p>
    {#if ops.reasons.length === 0}
      <p class="mt-3 text-sm text-muted-foreground" data-testid="reasons-none">{m.insights_reasons_none()}</p>
    {:else}
      <ul class="mt-3 space-y-2">
        {#each ops.reasons as r (r.reason)}
          <li data-testid="reason-row" data-reason={r.reason}>
            <div class="flex items-baseline justify-between gap-2 text-sm">
              <span>{reasonLabel(r.reason)}</span>
              <span class="tabular-nums text-muted-foreground">{Math.round(r.share * 100)}%</span>
            </div>
            <div class="mt-1 h-1.5 rounded-full bg-muted" aria-hidden="true">
              <div class="h-full rounded-full bg-warning" style:width={`${barWidth(r.perSecond, maxReason)}%`}></div>
            </div>
            <ItemLens lines={[`events.rejected{reason="${r.reason}"} ${r.perSecond}/s`]} />
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <h2 class="pt-2 text-sm font-medium">{m.insights_hour_title()}</h2>
  <div class="grid gap-3 md:grid-cols-3">
    <LazyChart testid="chart-events" title={m.insights_events()} points={pick(history.events, hour.events)} why={{ subject: 'metric', metric: 'events.accepted' }} lens={['insights.series events.accepted, 1 h']} />
    <LazyChart testid="chart-p95" title={m.insights_p95()} points={pick(history.p95, hour.p95)} why={{ subject: 'metric', metric: 'latency.p95' }} lens={['insights.series event.latency.p95, 1 h']} />
    <LazyChart testid="chart-errors" title={m.insights_errors()} points={pick(history.errors, hour.errors)} why={{ subject: 'metric', metric: 'errors' }} lens={['insights.series errors, 1 h']} />
  </div>
</section>

<section id="storage" aria-labelledby="storage-title" class="scroll-mt-20 space-y-3" data-testid="insights-storage">
  <h2 id="storage-title" class="pt-2 text-sm font-medium">{m.insights_storage_title()}</h2>
  <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
    <Stat testid="stat-db" label={m.insights_db()} value={formatBytes(ops.dbBytes)} why={ops.dbBytes === null ? { subject: 'metric', metric: 'db.size' } : { subject: 'metric', metric: 'db.size', value: ops.dbBytes }} lens={['events.stats().bytes (storage.bytes)']} />
    <Stat
      testid="stat-files"
      label={m.insights_files()}
      value={formatBytes(ops.blobBytes)}
      hint={ops.blobFiles === null ? undefined : m.insights_files_count({ count: ops.blobFiles })}
      why={ops.blobBytes === null ? { subject: 'metric', metric: 'blobs.bytes' } : { subject: 'metric', metric: 'blobs.bytes', value: ops.blobBytes }}
      lens={['blobIndex sizes (blobs.bytes / blobs.files)']}
    />
    {#if ops.diskFreeBytes !== null}
      <Stat testid="stat-disk" label={m.insights_disk_free()} value={formatBytes(ops.diskFreeBytes)} hint={ops.diskTotalBytes ? `${Math.round((ops.diskFreeBytes / ops.diskTotalBytes) * 100)}%` : undefined} why={{ subject: 'metric', metric: 'disk.free', value: ops.diskFreeBytes }} lens={['disk.free / disk.total']} />
    {/if}
  </div>
</section>
