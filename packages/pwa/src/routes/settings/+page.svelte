<script lang="ts">
  /** Settings (§6.1): persona at the top, goals, grouped sections, lens, history. */
  import { onMount } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Info from '@lucide/svelte/icons/info';
  import Lock from '@lucide/svelte/icons/lock';
  import Image from '@lucide/svelte/icons/image';
  import Bell from '@lucide/svelte/icons/bell';
  import Archive from '@lucide/svelte/icons/archive';
  import Globe from '@lucide/svelte/icons/globe';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Gauge from '@lucide/svelte/icons/gauge';
  import History from '@lucide/svelte/icons/history';
  import Shield from '@lucide/svelte/icons/shield';
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import Building2 from '@lucide/svelte/icons/building-2';
  import { app } from '$lib/stores/app.svelte';
  import { flow } from '$lib/stores/actions.svelte';
  import { prefs, type Theme } from '$lib/stores/prefs.svelte';
  import { personas, personaTitle } from '$lib/personas';
  import { SECTIONS } from '$lib/settings/sections';
  import { sectionTitle, sectionSummary } from '$lib/settings/labels';
  import type { Goals, Persona } from '$lib/api/types';
  import { to } from '$lib/nav';
  import Switch from '$lib/components/ui/switch.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  const icons: Record<string, typeof Info> = {
    info: Info,
    lock: Lock,
    image: Image,
    bell: Bell,
    archive: Archive,
    globe: Globe,
    sliders: SlidersHorizontal,
    shield: Shield,
  };

  let goals = $state<Goals | null>(null);
  let pickPersona = $state(false);
  const persona = $derived(app.relay?.persona);

  onMount(async () => {
    goals = (await app.api.relayConfig().catch(() => null))?.relay.goals ?? null;
  });

  function choose(p: Persona) {
    pickPersona = false;
    const def = app.action('config.apply-persona');
    // Organizations also get company sign-in: refresh the catalog and module screens too.
    const refresh = () => Promise.all([app.reloadRelays(), app.refreshCatalog()]);
    if (def) void flow.start(def, { persona: p }, { onDone: () => void refresh(), onUndo: () => void refresh() });
  }

  /** Screens this app draws itself, even when a module also lists them. */
  const OWN = new Set(['/settings/company']);
  const moduleSections = $derived(
    app.uiRoutes.filter((r) => r.placement === 'settings-section' && !OWN.has(r.path)),
  );
  /** Company sign-in: for organizations, or once the identity module is on. */
  const companyOn = $derived(
    app.hasAction('enterprise.connect-idp') || app.uiRoutes.some((r) => r.path === '/settings/company'),
  );
  const showCompany = $derived(persona === 'organization' || companyOn);
  const themes: Array<{ id: Theme; label: () => string }> = [
    { id: 'dark', label: () => m.theme_dark() },
    { id: 'light', label: () => m.theme_light() },
    { id: 'system', label: () => m.theme_system() },
  ];
</script>

<svelte:head><title>{m.nav_settings()} · {m.app_name()}</title></svelte:head>

<h1 class="mb-4 text-xl font-semibold tracking-tight">{m.nav_settings()}</h1>

<div class="space-y-6 md:max-w-2xl">
  <button
    class="flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left hover:bg-muted/40"
    onclick={() => (pickPersona = true)}
    data-testid="persona-card"
  >
    <span class="text-2xl" aria-hidden="true">{personas().find((p) => p.id === persona)?.emoji ?? '🛰️'}</span>
    <span class="min-w-0 flex-1">
      <span class="block text-sm">{m.settings_persona_line({ persona: personaTitle(persona) || m.settings_persona_unknown() })}</span>
      <span class="block text-xs text-primary">{m.settings_persona_change()}</span>
    </span>
    {#if prefs.lens}<span class="font-mono text-[10px] text-muted-foreground">{persona}</span>{/if}
  </button>

  <a href={to('/settings/goals')} class="flex items-center gap-3 rounded-xl border p-4 hover:bg-muted/40" data-testid="goals-link">
    <Gauge class="size-5 text-primary" />
    <span class="min-w-0 flex-1">
      <span class="block text-sm font-medium">{m.settings_goals_title()}</span>
      <span class="block truncate text-xs text-muted-foreground">
        {goals ? m.settings_goals_summary({ open: goals.openness, spam: goals.spamTolerance, storage: goals.storage }) : m.settings_goals_desc()}
      </span>
    </span>
    <ChevronRight class="size-4 text-muted-foreground" />
  </a>

  <section aria-labelledby="sections-title">
    <h2 id="sections-title" class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.settings_sections()}</h2>
    <ul class="divide-y overflow-hidden rounded-xl border">
      {#each SECTIONS as s (s.id)}
        {@const Icon = icons[s.icon] ?? Info}
        <li>
          <a href={to(`/settings/${s.id}`)} class="flex items-center gap-3 p-3.5 hover:bg-muted/40" data-testid={`section-${s.id}`}>
            <Icon class="size-4 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm">{sectionTitle(s.id)}</span>
              <span class="block truncate text-xs text-muted-foreground">{sectionSummary(s.id)}</span>
            </span>
            <ChevronRight class="size-4 text-muted-foreground" />
          </a>
        </li>
      {/each}
      {#if showCompany}
        <li>
          <a href={to('/settings/company')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40" data-testid="company-link">
            <Building2 class="size-4 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm">{m.company_title()}</span>
              <span class="block truncate text-xs text-muted-foreground">{companyOn ? m.company_summary_on() : m.company_summary_off()}</span>
            </span>
            <ChevronRight class="size-4 text-muted-foreground" />
          </a>
        </li>
      {/if}
      <li>
        <a href={to('/settings/plugins')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40">
          <Puzzle class="size-4 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm">{m.settings_plugins_title()}</span>
            <span class="block text-xs text-muted-foreground">{m.settings_plugins_summary()}</span>
          </span>
          <ChevronRight class="size-4 text-muted-foreground" />
        </a>
      </li>
      {#each moduleSections as r (r.path)}
        <li>
          <a href={to(`/m${r.path}`)} class="flex items-center gap-3 p-3.5 hover:bg-muted/40">
            <Puzzle class="size-4 text-muted-foreground" />
            <span class="flex-1 text-sm">{r.title}</span>
            <ChevronRight class="size-4 text-muted-foreground" />
          </a>
        </li>
      {/each}
    </ul>
  </section>

  <section class="divide-y overflow-hidden rounded-xl border">
    <a href={to('/settings/history')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40" data-testid="history-link">
      <History class="size-4 text-muted-foreground" />
      <span class="flex-1 text-sm">{m.history_title()}</span>
      <ChevronRight class="size-4 text-muted-foreground" />
    </a>
    <a href={to('/settings/security')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40">
      <Shield class="size-4 text-muted-foreground" />
      <span class="flex-1 text-sm">{m.security_title()}</span>
      <ChevronRight class="size-4 text-muted-foreground" />
    </a>
    <a href={to('/help')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40">
      <LifeBuoy class="size-4 text-muted-foreground" />
      <span class="flex-1 text-sm">{m.help_title()}</span>
      <ChevronRight class="size-4 text-muted-foreground" />
    </a>
  </section>

  <section class="space-y-4 rounded-xl border p-4" aria-labelledby="appearance-title">
    <h2 id="appearance-title" class="text-sm font-medium">{m.settings_appearance()}</h2>
    <div class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <p class="text-sm" id="lens-label">{m.lens_title()}</p>
        <p class="text-xs text-muted-foreground">{m.lens_desc()}</p>
      </div>
      <Switch checked={prefs.lens} label={m.lens_title()} onCheckedChange={(v) => prefs.setLens(v)} data-testid="lens-toggle" />
    </div>
    <div class="flex gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label={m.settings_theme()}>
      {#each themes as t (t.id)}
        <button
          role="radio"
          aria-checked={prefs.theme === t.id}
          class={cn('flex-1 rounded-md py-1.5 text-xs', prefs.theme === t.id ? 'bg-background shadow-sm' : 'text-muted-foreground')}
          onclick={() => prefs.setTheme(t.id)}
        >
          {t.label()}
        </button>
      {/each}
    </div>
  </section>

  <button class="w-full rounded-xl border p-3 text-sm text-destructive md:hidden" onclick={() => app.signOut()}>{m.signout()}</button>
</div>

<Sheet bind:open={pickPersona} title={m.settings_persona_pick()} description={m.settings_persona_pick_desc()}>
  <div class="grid gap-2">
    {#each personas() as p (p.id)}
      <button
        class={cn('flex items-start gap-3 rounded-xl border p-3 text-left hover:bg-muted/60', p.id === persona && 'border-primary')}
        onclick={() => choose(p.id)}
      >
        <span class="text-xl">{p.emoji}</span>
        <span>
          <span class="block text-sm font-medium">{p.title}</span>
          <span class="block text-xs text-muted-foreground">{p.description}</span>
        </span>
      </button>
    {/each}
  </div>
</Sheet>
