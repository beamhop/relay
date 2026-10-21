<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Plugins (§9): browse the catalog, add a plugin (what it may do is shown
   * first; it arrives turned off), review its settings, then turn it on.
   * Per plugin: how often it runs, what it blocks, speed and errors; change
   * settings; remove. A safety-switch card explains plugins Beamhop turned off.
   * With the assistant on, "Write a plugin" turns a description into a tested
   * plugin that arrives turned off (§6.5.4).
   */
  import { onDestroy, onMount } from 'svelte';
  import type { Component } from 'svelte';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Filter from '@lucide/svelte/icons/filter';
  import Network from '@lucide/svelte/icons/network';
  import ListChecks from '@lucide/svelte/icons/list-checks';
  import Gauge from '@lucide/svelte/icons/gauge';
  import BadgeCheck from '@lucide/svelte/icons/badge-check';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import Plus from '@lucide/svelte/icons/plus';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { PluginCatalogItem, PluginStatusRow } from '$lib/api/types';
  import { fieldsFromSchema } from '$lib/forms/json-schema';
  import { flatten, formDefaults, unflatten } from '$lib/forms/values';
  import { to } from '$lib/nav';
  import { ago, cn } from '$lib/utils';
  import Sheet from '$lib/components/Sheet.svelte';
  import GeneratedForm from '$lib/components/forms/LazyForm.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import PluginWriter from '$lib/components/plugins/PluginWriter.svelte';
  import { DeferredDiscard, aiMarked, markAi, writtenByAssistant } from '$lib/components/plugins/writer';
  import { m } from '$lib/paraglide/messages.js';

  const ICONS: Record<string, Component> = {
    'keyword-filter': Filter,
    'wot-strict': Network,
    'kind-allowlist': ListChecks,
    'rate-limit-burst': Gauge,
    'nip05-required': BadgeCheck,
  };
  const iconFor = (id: string) => ICONS[id] ?? Puzzle;

  let items = $state<PluginCatalogItem[] | null>(null);
  let rows = $state<PluginStatusRow[]>([]);
  let remoteError = $state<string | null>(null);
  let configuring = $state<{ item: PluginCatalogItem | undefined; row: PluginStatusRow | undefined; id: string } | null>(
    null,
  );
  let configOpen = $state(false);
  let jsonText = $state('');
  let jsonError = $state<string | null>(null);

  const available = $derived(app.hasAction('plugins.catalog'));
  const canWrite = $derived(app.hasAction('ai.generate-plugin'));
  let writerOpen = $state(false);
  let marked = $state(aiMarked());
  /** Drafts discarded from the writer, removed once their undo window has passed. */
  let discarding = $state<string[]>([]);
  const DISCARD_MS = 8000;
  const discarder = new DeferredDiscard(async (id) => {
    discarding = discarding.filter((x) => x !== id);
    const def = app.action('plugins.uninstall');
    if (def) await app.api.run(def.id, { id }, def.scope).catch(() => undefined);
    markAi(id, false);
    marked = aiMarked();
    void load();
  }, DISCARD_MS);
  onDestroy(() => discarder.flush());

  function discardDraft(id: string, name: string) {
    discarder.schedule(id);
    discarding = [...discarding, id];
    toasts.success(
      m.plugin_writer_discarded({ name }),
      async () => {
        discarder.cancel(id);
        discarding = discarding.filter((x) => x !== id);
      },
      Math.floor((Date.now() + DISCARD_MS) / 1000),
    );
  }

  function writerChanged() {
    marked = aiMarked();
    void load();
  }

  async function load() {
    const [cat, st] = await Promise.all([
      query<{ items: PluginCatalogItem[]; remoteError?: string }>('plugins.catalog', {}),
      query<{ plugins: PluginStatusRow[] }>('plugins.status', {}),
    ]);
    items = cat?.items ?? [];
    remoteError = cat?.remoteError ?? null;
    rows = st?.plugins ?? [];
  }
  onMount(() => {
    void load();
  });

  const rowOf = (id: string) => rows.find((r) => r.id === id);
  const installed = $derived.by(() => {
    const ids = new Set([...(items ?? []).filter((i) => i.installed).map((i) => i.id), ...rows.map((r) => r.id)]);
    return [...ids]
      .filter((id) => !discarding.includes(id))
      .map((id) => ({ id, item: items?.find((i) => i.id === id), row: rowOf(id) }));
  });
  const catalog = $derived((items ?? []).filter((i) => !i.installed && !rowOf(i.id)));
  const tripped = $derived(rows.filter((r) => r.status === 'tripped' || r.tripped));

  function run(id: string, input: Record<string, unknown>) {
    const def = app.action(id);
    if (!def) return;
    void flow.start(def, input, { onDone: () => void load(), onUndo: () => void load() });
  }

  /** Add a plugin turned off: the preview lists what it may do; it is turned on after review. */
  const install = (item: PluginCatalogItem) => run('plugins.install', { id: item.id, enable: false });
  const setEnabled = (id: string, on: boolean) => run(on ? 'plugins.enable' : 'plugins.disable', { id });
  const uninstall = (id: string) => run('plugins.uninstall', { id });

  const schemaOf = (c: NonNullable<typeof configuring>) => c.row?.configSchema ?? c.item?.configSchema;
  const configFields = $derived(configuring && schemaOf(configuring) ? fieldsFromSchema(schemaOf(configuring)!) : []);

  function configure(id: string) {
    configuring = { id, item: items?.find((i) => i.id === id), row: rowOf(id) };
    jsonText = JSON.stringify(configuring.row?.config ?? {}, null, 2);
    jsonError = null;
    configOpen = true;
  }

  function saveConfig(config: Record<string, unknown>) {
    if (!configuring) return;
    const id = configuring.id;
    configOpen = false;
    run('plugins.configure', { id, config });
  }

  function saveJson() {
    try {
      const v = JSON.parse(jsonText || '{}') as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object');
      saveConfig(v as Record<string, unknown>);
    } catch {
      jsonError = m.plugins_json_invalid();
    }
  }

  const statusTone = (s: PluginStatusRow['status']) =>
    s === 'running' ? 'ok' : s === 'tripped' || s === 'error' ? 'critical' : 'neutral';
  const statusLabel = (s: PluginStatusRow['status']) =>
    ({
      running: m.plugins_status_running(),
      disabled: m.plugins_status_off(),
      tripped: m.plugins_status_tripped(),
      error: m.plugins_status_error(),
      loading: m.plugins_status_loading(),
    })[s] ?? s;
  const fmtMs = (n: number) => (n < 1 ? '<1' : n < 10 ? n.toFixed(1) : String(Math.round(n)));
</script>

<svelte:head><title>{m.settings_plugins_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.settings_plugins_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.plugins_intro()}</p>

<div class="mt-4 space-y-6 md:max-w-2xl" data-testid="plugins">
  {#if !available}
    <div class="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center" data-testid="plugins-unavailable">
      <Puzzle class="size-8 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">{m.plugins_unavailable()}</p>
    </div>
  {:else if items === null}
    <div class="space-y-2"><Skeleton class="h-20 w-full" /><Skeleton class="h-20 w-full" /></div>
  {:else}
    {#if canWrite}
      <button
        type="button"
        class="flex w-full items-start gap-3 rounded-xl border bg-primary/5 p-4 text-left hover:bg-primary/10"
        onclick={() => (writerOpen = true)}
        data-testid="plugin-write"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles class="size-4" /></span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium">{m.plugin_writer_entry()}</span>
          <span class="mt-0.5 block text-xs text-muted-foreground">{m.plugin_writer_entry_hint()}</span>
        </span>
      </button>
    {/if}
    {#each tripped as t (t.id)}
      <section class="rounded-xl border border-destructive/40 bg-destructive/5 p-4" data-testid="plugin-safety" role="alert">
        <div class="flex items-start gap-3">
          <ShieldOff class="mt-0.5 size-5 shrink-0 text-destructive" />
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-medium">{m.plugins_safety_title({ name: t.name })}</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              {m.plugins_safety_body({ reason: t.tripped?.reason ?? m.plugins_safety_unknown() })}
              {#if t.tripped?.at}<span class="text-xs"> · {ago(t.tripped.at)}</span>{/if}
            </p>
            {#if prefs.lens && t.stats.lastError}<p class="mt-1 font-mono text-[11px] text-muted-foreground" data-lens>{t.stats.lastError}</p>{/if}
            <div class="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onclick={() => setEnabled(t.id, true)} data-testid="safety-turn-on">{m.plugins_turn_on_again()}</Button>
              <Button size="sm" variant="secondary" onclick={() => uninstall(t.id)}>{m.plugins_remove()}</Button>
            </div>
          </div>
        </div>
      </section>
    {/each}

    <section aria-labelledby="installed-title">
      <h2 id="installed-title" class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.plugins_installed()}</h2>
      {#if installed.length === 0}
        <p class="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="plugins-none">{m.plugins_none()}</p>
      {:else}
        <ul class="divide-y overflow-hidden rounded-xl border">
          {#each installed as p (p.id)}
            {@const Icon = iconFor(p.id)}
            {@const r = p.row}
            {@const on = r?.enabled ?? p.item?.enabled ?? false}
            <li class="p-4" data-testid="plugin-installed" data-plugin={p.id} data-enabled={on}>
              <div class="flex items-start gap-3">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon class="size-4" /></span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="text-sm font-medium">{p.item?.name ?? r?.name ?? p.id}</p>
                    {#if r}<Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>{/if}
                    {#if writtenByAssistant(p.id, r as { source?: unknown } | undefined, marked)}
                      <span data-testid="plugin-ai-badge"><Badge tone="accent"><Sparkles class="size-3" />{m.plugin_writer_badge()}</Badge></span>
                    {/if}
                  </div>
                  {#if p.item?.description}<p class="mt-0.5 text-xs text-muted-foreground">{p.item.description}</p>{/if}
                  {#if !on && r?.status !== 'tripped'}
                    <p class="mt-1 text-xs text-primary" data-testid="plugin-review-hint">{m.plugins_review_hint()}</p>
                  {/if}
                  {#if r}
                    <dl class="mt-2 grid grid-cols-4 gap-2 text-center" data-testid="plugin-stats">
                      <div class="rounded-md bg-muted/50 px-1 py-1.5"><dt class="text-[10px] text-muted-foreground">{m.plugins_stat_calls()}</dt><dd class="text-sm tabular-nums">{r.stats.calls}</dd></div>
                      <div class="rounded-md bg-muted/50 px-1 py-1.5"><dt class="text-[10px] text-muted-foreground">{m.plugins_stat_blocked()}</dt><dd class="text-sm tabular-nums">{r.stats.rejections}</dd></div>
                      <div class="rounded-md bg-muted/50 px-1 py-1.5"><dt class="text-[10px] text-muted-foreground">{m.plugins_stat_speed()}</dt><dd class="text-sm tabular-nums">{fmtMs(r.stats.avgMs)} ms</dd></div>
                      <div class="rounded-md bg-muted/50 px-1 py-1.5"><dt class="text-[10px] text-muted-foreground">{m.plugins_stat_errors()}</dt><dd class={cn('text-sm tabular-nums', r.stats.errors + r.stats.timeouts > 0 && 'text-destructive')}>{r.stats.errors + r.stats.timeouts}</dd></div>
                    </dl>
                    {#if prefs.lens}
                      <p class="mt-1 font-mono text-[10px] text-muted-foreground" data-lens>
                        {p.id}@{r.version} · {r.mode ?? '—'} · p95 {r.stats.p95Ms} ms · timeouts {r.stats.timeouts}{r.permissions.length ? ` · ${r.permissions.join(', ')}` : ''}
                      </p>
                    {/if}
                    {#if r.error}<p class="mt-1 text-xs text-destructive">{r.error}</p>{/if}
                  {/if}
                  <div class="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onclick={() => configure(p.id)} data-testid="plugin-configure">{m.plugins_settings()}</Button>
                    <Button size="sm" variant="ghost" onclick={() => uninstall(p.id)} data-testid="plugin-remove">{m.plugins_remove()}</Button>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={on ? 'secondary' : 'default'}
                  onclick={() => setEnabled(p.id, !on)}
                  data-testid="plugin-toggle"
                >
                  {on ? m.plugins_turn_off() : m.plugins_turn_on()}
                </Button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="catalog-title">
      <h2 id="catalog-title" class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.plugins_catalog()}</h2>
      {#if remoteError}<p class="mb-2 text-xs text-warning">{m.plugins_remote_error()}{#if prefs.lens} · {remoteError}{/if}</p>{/if}
      {#if catalog.length === 0}
        <p class="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{m.plugins_catalog_empty()}</p>
      {:else}
        <ul class="divide-y overflow-hidden rounded-xl border" data-testid="plugin-catalog">
          {#each catalog as item (item.id)}
            {@const Icon = iconFor(item.id)}
            <li class="flex items-start gap-3 p-4" data-testid="plugin-available" data-plugin={item.id}>
              <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon class="size-4" /></span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium">{item.name ?? item.id}</p>
                {#if item.description}<p class="mt-0.5 text-xs text-muted-foreground">{item.description}</p>{/if}
                <p class="mt-1 text-[11px] text-muted-foreground">
                  {(item.permissionText ?? []).length ? m.plugins_can({ what: (item.permissionText ?? []).join(' · ').toLowerCase() }) : m.plugins_no_permissions()}
                </p>
                {#if prefs.lens}<p class="font-mono text-[10px] text-muted-foreground" data-lens>{item.id}@{item.version}{item.builtin ? ' · builtin' : ''}</p>{/if}
                {#if item.compatible === false}<p class="mt-1 text-xs text-warning">{m.plugins_incompatible({ version: item.minBeamhop ?? '' })}</p>{/if}
              </div>
              <Button size="sm" disabled={item.compatible === false || !app.hasAction('plugins.install')} onclick={() => install(item)} data-testid="plugin-add">
                <Plus class="size-4" />{m.plugins_add()}
              </Button>
            </li>
          {/each}
        </ul>
        <p class="mt-2 px-1 text-xs text-muted-foreground">{m.plugins_added_off()}</p>
      {/if}
    </section>
  {/if}
</div>

<Sheet
  bind:open={configOpen}
  title={m.plugins_settings_title({ name: configuring?.item?.name ?? configuring?.row?.name ?? configuring?.id ?? '' })}
  testid="plugin-config-sheet"
>
  {#if configuring}
    {#if configFields.length}
      {#key configuring.id}
        <GeneratedForm
          id="plugin-config"
          fields={configFields}
          initial={{ ...formDefaults(configFields), ...flatten(configuring.row?.config ?? {}, configFields) }}
          onsubmit={(v) => saveConfig(unflatten(v, configFields))}
        />
      {/key}
    {:else}
      <p class="mb-2 text-sm text-muted-foreground">{m.plugins_json_help()}</p>
      <textarea
        class="h-48 w-full rounded-lg border bg-background p-3 font-mono text-xs"
        bind:value={jsonText}
        aria-label={m.plugins_settings()}
        data-testid="plugin-config-json"
      ></textarea>
      {#if jsonError}<p class="mt-1 text-xs text-destructive" role="alert">{jsonError}</p>{/if}
    {/if}
  {/if}
  {#snippet footer()}
    {#if configFields.length}
      <Button class="w-full" type="submit" form="plugin-config" data-testid="plugin-config-save">{m.action_review()}</Button>
    {:else}
      <Button class="w-full" onclick={saveJson} data-testid="plugin-config-save">{m.action_review()}</Button>
    {/if}
  {/snippet}
</Sheet>

{#if canWrite}
  <PluginWriter bind:open={writerOpen} onchanged={writerChanged} ondiscard={discardDraft} />
{/if}
