<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Insights (§6.1, §8): live ops and community analytics. Reached from the
   * Home tiles and a small link on People and Media — not a tab of its own.
   * The live panel follows `insights.tick` on the live channel; the hour charts
   * come from `insights.series`.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/app.svelte';
  import {
    emptyHistory,
    loadCommunity,
    loadOverview,
    loadSeries,
    pushHistory,
    summarizeLive,
    watchTicks,
    type CommunityResult,
    type LiveHistory,
    type LiveOps,
  } from '$lib/insights';
  import { to } from '$lib/nav';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import LivePanel from './LivePanel.svelte';
  import CommunityPanel from './CommunityPanel.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let ops = $state<LiveOps | null>(null);
  let absent = $state(false);
  let error = $state<unknown>(null);
  let history = $state<LiveHistory>(emptyHistory());
  let hour = $state<{ events: number[]; p95: number[]; errors: number[] }>({ events: [], p95: [], errors: [] });
  let community = $state<CommunityResult | null>(null);
  let connected = $state(false);

  async function load() {
    error = null;
    try {
      const o = await loadOverview(app.api, app.catalog);
      if (!o) {
        absent = true;
        return;
      }
      absent = false;
      ops = o.ops;
      history = pushHistory(history, o.ops);
    } catch (err) {
      error = err;
    }
    const [events, p95, errors] = await Promise.all([
      loadSeries(app.api, app.catalog, 'events.accepted', 1),
      loadSeries(app.api, app.catalog, 'event.latency.p95', 1),
      loadSeries(app.api, app.catalog, 'errors', 1),
    ]);
    hour = { events: events ?? [], p95: p95 ?? [], errors: errors ?? [] };
    community = await loadCommunity(app.api, app.catalog, 30);
  }

  onMount(() => {
    void load().then(() => {
      const id = location.hash.slice(1);
      if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
    const abort = new AbortController();
    if (app.hasAction('insights.overview') && app.relayId)
      watchTicks(
        app.api,
        (snap) => {
          const next = summarizeLive(snap);
          ops = next;
          history = pushHistory(history, next);
        },
        abort.signal,
        (up) => (connected = up),
      );
    return () => abort.abort();
  });
</script>

<svelte:head><title>{m.insights_title()} · {m.app_name()}</title></svelte:head>

<PullToRefresh onrefresh={load}>
  <div class="space-y-6">
    <div>
      <a href={to('/')} class="text-sm text-muted-foreground">← {m.nav_home()}</a>
      <h1 class="mt-2 text-xl font-semibold tracking-tight">{m.insights_title()}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{m.insights_intro()}</p>
    </div>

    {#if error}<ErrorPanel {error} reset={load} />{/if}

    {#if absent}
      <p class="rounded-xl border border-dashed p-5 text-sm text-muted-foreground" data-testid="insights-absent">{m.insights_absent()}</p>
    {:else if ops}
      <LivePanel {ops} {history} {hour} {connected} />
    {:else if !error}
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">{#each Array(4) as _, i (i)}<Skeleton class="h-24 w-full" />{/each}</div>
    {/if}

    {#if community?.state === 'ok'}
      <CommunityPanel report={community.report} />
    {:else if community?.state === 'off'}
      <section id="community" class="space-y-2" data-testid="insights-community-off">
        <h2 class="text-sm font-medium">{m.insights_community_title()}</h2>
        <p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{m.insights_community_off()}</p>
      </section>
    {/if}

    {#if !absent}<p class="text-center text-xs text-muted-foreground">{m.insights_privacy()}</p>{/if}
  </div>
</PullToRefresh>
