<script lang="ts">
  /** Home (§6.1, §6.9): "is everything OK, and what needs me?" */
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/app.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import type { BlobItem, Health, NodeConfig, RelayConfig } from '$lib/api/types';
  import {
    checklist,
    fromServer,
    landingCustomized,
    recoverySaved,
    type ChecklistItem,
    type ServerChecklist,
  } from '$lib/checklist';
  import { loadCards, type HomeCard } from '$lib/cards';
  import { loadInsights, type Insights } from '$lib/insights';
  import { pushEnabled } from '$lib/push';
  import { formatBytes } from '$lib/utils';
  import HealthRing from '$lib/components/home/HealthRing.svelte';
  import SparkTile from '$lib/components/home/SparkTile.svelte';
  import AttentionStack from '$lib/components/home/AttentionStack.svelte';
  import SetupChecklist from '$lib/components/home/SetupChecklist.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let health = $state<Health | null>(null);
  let cards = $state<HomeCard[] | null>(null);
  let insights = $state<Insights | null>(null);
  let error = $state<unknown>(null);
  let items = $state<ChecklistItem[]>([]);
  let storage = $state<number | null>(null);
  let tile = $state<{ title: string; points: number[]; unit: string; help: string } | null>(null);
  let tileOpen = $state(false);

  async function load() {
    error = null;
    const relay = !!app.relayId;
    try {
      const [h, c] = await Promise.all([app.api.health(relay), loadCards(app.api, app.catalog, app.relayId)]);
      health = h;
      cards = c;
    } catch (err) {
      error = err;
    }
    void loadChecklist();
    void loadStorage();
    insights = await loadInsights(app.api, app.catalog).catch(() => null);
  }

  async function loadChecklist() {
    const server = await query<ServerChecklist>('experience.checklist');
    if (server) {
      items = fromServer(server, app.uiRoutes.map((r) => r.path));
      return;
    }
    if (!app.can('config.write', false)) {
      items = [];
      return;
    }
    const [cfg, team, push] = await Promise.all([
      app.api.config().catch(() => null),
      query<{ admins: unknown[] }>('admins.list'),
      pushEnabled(),
    ]);
    const conf = cfg?.config as NodeConfig | undefined;
    const relay = conf?.relays.find((r) => r.id === app.relayId) as RelayConfig | undefined;
    items = checklist({
      backupsEnabled: !!conf?.backups?.enabled,
      alertChannels: conf?.alerts?.channels?.length ?? 0,
      pushEnabled: push,
      recoverySaved: recoverySaved(),
      landingCustomized: landingCustomized(relay?.info),
      teamSize: team?.admins.length ?? 1,
    });
  }

  async function loadStorage() {
    const out = await query<{ items: BlobItem[]; cursor?: string }>('media.list-blobs', { limit: 500 });
    storage = out ? out.items.reduce((a, b) => a + (b.size ?? 0), 0) : null;
  }

  onMount(() => {
    void load();
  });

  // Reload cards when something relevant happens live (debounced by the live store's batching).
  let lastTick = 0;
  $effect(() => {
    const t = live.tick;
    if (t !== lastTick && t > 0) {
      lastTick = t;
      const relay = !!app.relayId;
      void relay;
      void loadCards(app.api, app.catalog, app.relayId)
        .then((c) => (cards = c))
        .catch(() => {});
    }
  });

  // Reload everything when the relay changes.
  let lastRelay: string | null = null;
  $effect(() => {
    const r = app.relayId;
    if (r !== lastRelay) {
      if (lastRelay !== null) void load();
      lastRelay = r;
    }
  });

  const last = (xs: number[]) => (xs.length ? xs[xs.length - 1] : undefined);
  const statusText = $derived(
    !health ? '' : health.status === 'ok' ? m.health_ok() : health.status === 'warn' ? m.health_warn() : m.health_critical(),
  );

  function openTile(title: string, points: number[], unit: string, help: string) {
    tile = { title, points, unit, help };
    tileOpen = true;
  }
</script>

<svelte:head><title>{m.nav_home()} · {m.app_name()}</title></svelte:head>

<PullToRefresh onrefresh={load}>
  <div class="space-y-6">
    {#if error}
      <ErrorPanel {error} reset={load} />
    {/if}

    <section class="flex items-center gap-5 rounded-2xl border bg-card p-5" aria-labelledby="health-title">
      {#if health}
        <HealthRing score={health.score} status={health.status} label={m.health_label({ score: health.score })} />
        <div class="min-w-0 flex-1">
          <h1 id="health-title" class="text-lg font-semibold">{statusText}</h1>
          <p class="mt-0.5 text-sm text-muted-foreground">{health.message}</p>
          <ul class="mt-3 flex flex-wrap gap-x-3 gap-y-1.5" aria-label={m.health_subsystems()}>
            {#each health.subsystems as s (s.subsystem)}
              <li class="flex items-center gap-1.5 text-xs" title={s.message} data-testid={`light-${s.subsystem}`}>
                <span
                  class="size-2 rounded-full {s.status === 'ok' ? 'bg-success' : s.status === 'warn' ? 'bg-warning' : 'bg-destructive'}"
                ></span>
                <span class="capitalize text-muted-foreground">{s.subsystem}</span>
                {#if prefs.lens}<span class="font-mono text-[10px] text-muted-foreground">{s.score}</span>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <Skeleton class="size-[120px] rounded-full" />
        <div class="flex-1 space-y-2"><Skeleton class="h-5 w-32" /><Skeleton class="h-4 w-48" /></div>
      {/if}
    </section>

    {#if cards}
      <AttentionStack {cards} onchange={load} />
    {:else}
      <Skeleton class="h-36 w-full" />
    {/if}

    <section aria-label={m.home_tiles()} class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <SparkTile
        testid="tile-connections"
        label={m.tile_connections()}
        value={(insights?.connections ?? last(live.connections))?.toString() ?? '—'}
        points={insights?.series.connections ?? live.connections}
        onclick={() => openTile(m.tile_connections(), insights?.series.connections ?? live.connections, '', m.tile_connections_help())}
      />
      <SparkTile
        testid="tile-events"
        label={m.tile_events()}
        value={insights ? String(insights.eventsPerSecond) : live.connected ? String(last(live.eventsPerSec) ?? 0) : '—'}
        points={insights?.series.events ?? live.eventsPerSec}
        onclick={() => openTile(m.tile_events(), insights?.series.events ?? live.eventsPerSec, '/s', m.tile_events_help())}
      />
      <SparkTile
        testid="tile-errors"
        label={m.tile_errors()}
        value={insights ? String(insights.errorsPerMinute) : live.connected ? String(live.errors.reduce((a, b) => a + b, 0)) : '—'}
        points={insights?.series.errors ?? live.errors}
        onclick={() => openTile(m.tile_errors(), insights?.series.errors ?? live.errors, '', m.tile_errors_help())}
      />
      <SparkTile
        testid="tile-storage"
        label={m.tile_storage()}
        value={insights?.storageBytes != null ? formatBytes(insights.storageBytes) : storage === null ? '—' : formatBytes(storage + (last(live.storageBytes) ?? 0))}
        points={live.storageBytes}
        onclick={() => openTile(m.tile_storage(), live.storageBytes, 'B', m.tile_storage_help())}
      />
    </section>

    <SetupChecklist
      {items}
      onaction={(item) => {
        const def = item.action && app.action(item.action.id);
        if (def && item.action) void flow.start(def, item.action.input, { onDone: () => loadChecklist() });
      }}
    />
  </div>
</PullToRefresh>

<Sheet bind:open={tileOpen} title={tile?.title} description={tile?.help}>
  {#if tile}
    {#if tile.points.length > 1}
      {#await import('$lib/components/home/DetailChart.svelte')}
        <Skeleton class="h-48 w-full" />
      {:then mod}
        {@const DetailChart = mod.default}
        <DetailChart points={tile.points} />
      {:catch}
        <p class="text-sm text-muted-foreground">{m.tile_no_data()}</p>
      {/await}
      <p class="mt-2 text-xs text-muted-foreground">{m.tile_window()}</p>
    {:else}
      <p class="text-sm text-muted-foreground">{m.tile_no_data()}</p>
    {/if}
  {/if}
</Sheet>
