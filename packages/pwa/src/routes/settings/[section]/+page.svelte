<script lang="ts">
  /**
   * One simple settings screen (≤ 7 settings, §6.6), generated from the
   * config JSON Schema. Extra settings live in the "Advanced" sheet. Saving:
   * propose → plain-language diff → apply → 5-minute undo.
   */
  import { page } from '$app/state';
  import Bell from '@lucide/svelte/icons/bell';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { configFlow } from '$lib/stores/config.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { sectionById } from '$lib/settings/sections';
  import { loadSection, patchFor, type LoadedSection } from '$lib/settings/load';
  import { sectionSummary, sectionTitle } from '$lib/settings/labels';
  import { enablePush } from '$lib/push';
  import type { FieldSpec } from '$lib/forms/json-schema';
  import type { SelfCheck } from '$lib/api/types';
  import { to } from '$lib/nav';
  import { goto } from '$app/navigation';
  import { resolveScreen } from '$lib/screens';
  import { announceFallback } from '$lib/fallback';
  import GeneratedForm from '$lib/components/forms/GeneratedForm.svelte';
  import ChannelsEditor from '$lib/components/settings/ChannelsEditor.svelte';
  import type { AlertChannel } from '$lib/alert-channels';
  import type { NodeConfig } from '$lib/api/types';
  import Sheet from '$lib/components/Sheet.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const id = $derived(page.params.section ?? '');
  const def = $derived(sectionById(id));

  // Unknown section (old link, server-named screen): nearest screen + a toast, never a dead end.
  let redirected = '';
  $effect(() => {
    if (def || !id || redirected === id) return;
    redirected = id;
    const target = resolveScreen(`/settings/${id}`, app.uiRoutes.map((r) => r.path));
    if (target.fallback) announceFallback(target.tab);
    void goto(to(target.href), { replaceState: true });
  });

  let data = $state<LoadedSection | null>(null);
  let error = $state<unknown>(null);
  let advancedOpen = $state(false);
  let version = $state(0);
  let check = $state<SelfCheck | null>(null);

  async function load() {
    if (!def) return;
    error = null;
    try {
      data = await loadSection(app.api, def, app.relayId);
      version++;
    } catch (err) {
      error = err;
    }
    if (def.id === 'domains') check = await app.api.selfCheck().catch(() => null);
  }

  let loadedFor = '';
  $effect(() => {
    const key = `${id}|${app.relayId}`;
    if (key !== loadedFor) {
      loadedFor = key;
      data = null;
      void load();
    }
  });

  /** Settings with their own editor instead of a generated field. */
  const CUSTOM = new Set(['alerts.channels']);
  const simpleFields = $derived(data ? data.simple.filter((f) => !CUSTOM.has(f.path.join('.'))) : []);
  const channels = $derived(
    def?.id === 'alerts' && data ? (((data.doc as NodeConfig).alerts?.channels ?? []) as AlertChannel[]) : [],
  );

  async function save(fields: FieldSpec[], values: Record<string, unknown>) {
    if (!data) return;
    const patch = patchFor(data.doc, fields, values);
    if (!patch.length) {
      toasts.show({ message: m.settings_nothing_changed(), kind: 'info' });
      return;
    }
    const ok = await configFlow.propose(
      { patch, summary: m.settings_change_summary({ section: sectionTitle(id) }) },
      { relay: data.def.scope === 'relay', onApplied: () => load() },
    );
    if (ok) advancedOpen = false;
  }

  async function phoneAlerts() {
    try {
      const r = await enablePush(app.api, app.catalog);
      if (r === 'enabled') toasts.success(m.push_enabled());
      else toasts.show({ message: r === 'denied' ? m.push_denied() : r === 'unsupported' ? m.push_unsupported() : m.push_unavailable(), kind: 'info' });
    } catch (err) {
      toasts.error(asApiError(err).message);
    }
  }
</script>

<svelte:head><title>{sectionTitle(id)} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>

{#if !def}
  <p class="mt-6 text-sm text-muted-foreground">{m.settings_unknown_section()}</p>
{:else}
  <h1 class="mt-2 text-xl font-semibold tracking-tight">{sectionTitle(id)}</h1>
  <p class="mt-1 text-sm text-muted-foreground">{sectionSummary(id)}</p>

  {#if def.id === 'alerts'}
    <Button variant="secondary" class="mt-4 w-full md:w-auto" onclick={phoneAlerts}><Bell class="size-4" />{m.wizard_alerts()}</Button>
  {/if}
  {#if def.id === 'domains' && check}
    <div class="mt-4 flex items-center gap-2 rounded-xl border p-3 text-sm" data-testid="tls-status">
      <ShieldCheck class="size-4" />
      <span class="flex-1">{check.tls === 'acme' ? m.wizard_tls_acme() : check.tls === 'proxy' ? m.wizard_tls_proxy() : m.wizard_tls_off()}</span>
      <Badge tone={check.ok ? 'ok' : 'warn'}>{check.ok ? m.wizard_tls_ok() : m.wizard_tls_issues()}</Badge>
    </div>
    {#each check.problems as p (p.message)}<p class="mt-2 text-sm text-warning">{p.message}</p>{/each}
  {/if}

  <div class="mt-4 md:max-w-xl">
    {#if error}
      <ErrorPanel {error} reset={load} />
    {:else if !data}
      <div class="space-y-4">{#each def.simple as p (p)}<Skeleton class="h-14 w-full" />{/each}</div>
    {:else}
      {#if def.id === 'alerts'}
        <div class="mb-4"><ChannelsEditor {channels} onchanged={load} /></div>
      {/if}
      {#key version}
        <div class="divide-y rounded-xl border px-4" data-testid="simple-screen" data-section={id}>
          <GeneratedForm
            id={`section-${id}`}
            fields={simpleFields}
            initial={data.initial}
            onsubmit={(v) => save(simpleFields, v)}
          />
        </div>
      {/key}
      <div class="mt-4 flex gap-2">
        {#if data.advanced.length}
          <Button variant="secondary" class="flex-1" onclick={() => (advancedOpen = true)} data-testid="advanced-open">{m.settings_advanced()}</Button>
        {/if}
        <Button class="flex-1" type="submit" form={`section-${id}`} disabled={configFlow.busy} data-testid="section-save">{m.common_save()}</Button>
      </div>
    {/if}
  </div>

  {#if data}
    <Sheet bind:open={advancedOpen} title={m.settings_advanced_title({ section: sectionTitle(id) })} description={m.settings_advanced_desc()}>
      {#key version}
        <GeneratedForm id={`advanced-${id}`} fields={data.advanced} initial={data.initial} onsubmit={(v) => save(data!.advanced, v)} />
      {/key}
      {#snippet footer()}
        <Button class="w-full" type="submit" form={`advanced-${id}`}>{m.common_save()}</Button>
      {/snippet}
    </Sheet>
  {/if}
{/if}
