<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Community analytics (§8): active people, what they post, which apps they
   * use, who comes back, who uses the most storage and (coarse) where visitors
   * are. Counted on the server; nothing leaves it.
   */
  import Stat from '$lib/components/home/Stat.svelte';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { barWidth, cohortPercents, countryName, topApps, type CommunityReport } from '$lib/insights';
  import { names } from '$lib/stores/names.svelte';
  import { sparkPaths } from '$lib/sparkline';
  import { formatBytes } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  let { report }: { report: CommunityReport } = $props();

  const u = $derived(report.activeUsers);
  const daily = $derived(report.dailyActive.map((d) => d.users));
  const spark = $derived(sparkPaths(daily, 100, 32));
  const kindMax = $derived(Math.max(0, ...report.topKinds.map((k) => k.count)));
  const apps = $derived(topApps(report));
  const appMax = $derived(Math.max(0, ...apps.map((a) => a.count)));
  const cohorts = $derived(cohortPercents(report.cohorts));
  const cohortCols = $derived(Math.max(0, ...cohorts.map((c) => c.cells.length)));
  const geoMax = $derived(Math.max(0, ...report.countries.map((c) => c.count)));
</script>

<section id="community" aria-labelledby="community-title" class="scroll-mt-20 space-y-3" data-testid="insights-community">
  <h2 id="community-title" class="pt-2 text-sm font-medium">{m.insights_community_title()}</h2>

  <div class="grid grid-cols-3 gap-3">
    <Stat testid="stat-dau" label={m.insights_dau()} value={String(u.daily)} why={{ subject: 'metric', metric: 'active-users.daily', value: u.daily }} lens={['HyperLogLog distinct pubkeys, today (UTC)']} />
    <Stat testid="stat-wau" label={m.insights_wau()} value={String(u.weekly)} why={{ subject: 'metric', metric: 'active-users.weekly', value: u.weekly }} lens={['union of 7 daily HLLs']} />
    <Stat testid="stat-mau" label={m.insights_mau()} value={String(u.monthly)} why={{ subject: 'metric', metric: 'active-users.monthly', value: u.monthly }} lens={['union of 30 daily HLLs']} />
  </div>
  {#if spark.line}
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" class="h-10 w-full" aria-hidden="true" data-sparkline>
      <path d={spark.area} class="fill-primary/15" />
      <path d={spark.line} fill="none" class="stroke-primary" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
  {/if}

  <div class="grid gap-3 md:grid-cols-2">
    <div class="rounded-xl border bg-card p-4" data-testid="insights-kinds">
      <h3 class="text-sm font-medium">{m.insights_kinds_title()}</h3>
      {#if report.topKinds.length === 0}
        <p class="mt-2 text-sm text-muted-foreground">{m.insights_nothing_yet()}</p>
      {:else}
        <ul class="mt-3 space-y-2">
          {#each report.topKinds as k (k.kind)}
            <li data-testid="kind-row">
              <div class="flex justify-between gap-2 text-sm"><span>{k.name ?? m.insights_reason_other()}</span><span class="tabular-nums text-muted-foreground">{k.count}</span></div>
              <div class="mt-1 h-1.5 rounded-full bg-muted" aria-hidden="true"><div class="h-full rounded-full bg-primary" style:width={`${barWidth(k.count, kindMax)}%`}></div></div>
              <ItemLens lines={[`kind ${k.kind}`]} />
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="rounded-xl border bg-card p-4" data-testid="insights-apps">
      <h3 class="text-sm font-medium">{m.insights_apps_title()}</h3>
      {#if apps.length === 0}
        <p class="mt-2 text-sm text-muted-foreground">{m.insights_nothing_yet()}</p>
      {:else}
        <ul class="mt-3 space-y-2">
          {#each apps as a (a.name)}
            <li data-testid="app-row">
              <div class="flex justify-between gap-2 text-sm"><span>{a.name}</span><span class="tabular-nums text-muted-foreground">{a.count}</span></div>
              <div class="mt-1 h-1.5 rounded-full bg-muted" aria-hidden="true"><div class="h-full rounded-full bg-primary" style:width={`${barWidth(a.count, appMax)}%`}></div></div>
              <ItemLens lines={[a.from.map((f) => (f === 'tag' ? 'NIP-89 client tag' : 'User-Agent product')).join(' + ')]} />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  <div class="rounded-xl border bg-card p-4" data-testid="insights-retention">
    <div class="flex items-baseline justify-between gap-2">
      <h3 class="text-sm font-medium">{m.insights_retention_title()}</h3>
      <WhyButton subject={{ subject: 'metric', metric: 'retention' }} />
    </div>
    <p class="mt-1 text-xs text-muted-foreground">{m.insights_retention_hint()}</p>
    {#if cohorts.length === 0}
      <p class="mt-2 text-sm text-muted-foreground">{m.insights_nothing_yet()}</p>
    {:else}
      <div class="mt-3 overflow-x-auto">
        <table class="w-full text-xs">
          <tbody>
            {#each cohorts as c (c.weekStart)}
              <tr data-testid="cohort-row">
                <th scope="row" class="whitespace-nowrap py-1 pr-2 text-left font-normal">
                  {m.insights_retention_week({ date: c.weekStart })}
                  <span class="block text-muted-foreground">{m.insights_retention_size({ count: c.size })}</span>
                </th>
                {#each Array.from({ length: cohortCols }, (_, i) => c.cells[i]) as cell, i (i)}
                  <td class="p-0.5">
                    {#if cell !== undefined}
                      <div class="rounded px-1.5 py-1 text-center tabular-nums" style:background={`color-mix(in oklab, var(--primary) ${Math.max(6, cell)}%, transparent)`}>{cell}%</div>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <div class="grid gap-3 md:grid-cols-2">
    <div class="rounded-xl border bg-card p-4" data-testid="insights-storage-users">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="text-sm font-medium">{m.insights_storage_users_title()}</h3>
        {#if report.storageTotal}<WhyButton subject={{ subject: 'metric', metric: 'blobs.bytes', value: report.storageTotal.bytes }} />{/if}
      </div>
      {#if report.storageByUser.length === 0}
        <p class="mt-2 text-sm text-muted-foreground">{m.insights_nothing_yet()}</p>
      {:else}
        <ul class="mt-3 divide-y text-sm">
          {#each report.storageByUser.slice(0, 10) as s (s.pubkey)}
            <li class="py-2" data-testid="storage-user-row">
              <div class="flex justify-between gap-2"><span class="truncate">{names.label(s.pubkey)}</span><span class="shrink-0 tabular-nums text-muted-foreground">{formatBytes(s.bytes)}</span></div>
              <span class="text-xs text-muted-foreground">{m.insights_files_count({ count: s.files })}</span>
              <ItemLens lines={[s.pubkey]} />
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="rounded-xl border bg-card p-4" data-testid="insights-geo">
      <h3 class="text-sm font-medium">{m.insights_geo_title()}</h3>
      {#if report.geoSource === 'off'}
        <p class="mt-2 text-sm text-muted-foreground">{m.insights_geo_off()}</p>
      {:else if report.countries.length === 0}
        <p class="mt-2 text-sm text-muted-foreground">{m.insights_nothing_yet()}</p>
      {:else}
        <ul class="mt-3 space-y-2">
          {#each report.countries.slice(0, 10) as c (c.country)}
            <li data-testid="geo-row">
              <div class="flex justify-between gap-2 text-sm"><span>{countryName(c.country)}</span><span class="tabular-nums text-muted-foreground">{c.count}</span></div>
              <div class="mt-1 h-1.5 rounded-full bg-muted" aria-hidden="true"><div class="h-full rounded-full bg-primary" style:width={`${barWidth(c.count, geoMax)}%`}></div></div>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="mt-3 text-xs text-muted-foreground">{m.insights_geo_privacy()}</p>
      <ItemLens lines={['country from runtime header (cf-ipcountry); no IPs stored']} />
    </div>
  </div>
</section>
