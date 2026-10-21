<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Settings (§6.1): persona at the top, goals, grouped sections, lens, history. */
  import { onDestroy, untrack } from 'svelte';
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
  import HeartPulse from '@lucide/svelte/icons/heart-pulse';
  import { app } from '$lib/stores/app.svelte';
  import { flow, runNow } from '$lib/stores/actions.svelte';
  import { configFlow } from '$lib/stores/config.svelte';
  import { prefs, type Theme } from '$lib/stores/prefs.svelte';
  import { personas, personaTitle } from '$lib/personas';
  import { SECTIONS } from '$lib/settings/sections';
  import { sectionTitle, sectionSummary } from '$lib/settings/labels';
  import { GOALS, goalsDiffer } from '$lib/settings/goals';
  import type { Goals, Persona, RelayConfig } from '$lib/api/types';
  import { to } from '$lib/nav';
  import Switch from '$lib/components/ui/switch.svelte';
  import Slider from '$lib/components/ui/slider.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
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

  type AccessMode = RelayConfig['access']['mode'];

  let pickPersona = $state(false);
  let backingUp = $state(false);
  const canBackUp = $derived(app.hasAction('backups.run-now'));

  /** A backup only adds data: run it at once, the result shows in a toast (§6.2, no confirm sheet). */
  async function backUpNow() {
    backingUp = true;
    await runNow('backups.run-now', {});
    backingUp = false;
  }
  const persona = $derived(app.relay?.persona);

  // ── Top tasks on this screen (§6.6): "Who can post" and the goal sliders change in one move + Apply. ──
  let relayCfg = $state<RelayConfig | null>(null);
  /** Goals as saved on the server, and as the sliders show them now. */
  let saved = $state<Goals | null>(null);
  let goals = $state<Goals | null>(null);
  /** A goal change is on the review sheet (or about to be). */
  let proposingGoals = $state(false);
  let commitTimer: ReturnType<typeof setTimeout> | undefined;

  async function loadRelay() {
    const r = (await app.api.relayConfig().catch(() => null))?.relay ?? null;
    relayCfg = r;
    saved = r ? { ...r.goals } : null;
    goals = r ? { ...r.goals } : null;
  }
  // Load on open, and again after every applied or undone settings change.
  $effect(() => {
    void configFlow.applied;
    untrack(() => void loadRelay());
  });
  onDestroy(() => clearTimeout(commitTimer));

  const mode = $derived(relayCfg?.access.mode);
  const WHO: Array<{ id: AccessMode; label: () => string; long: () => string }> = [
    { id: 'open', label: () => m.tt_who_open(), long: () => m.access_mode_open() },
    { id: 'allowlist', label: () => m.tt_who_allowlist(), long: () => m.access_mode_allowlist() },
    { id: 'wot', label: () => m.tt_who_wot(), long: () => m.access_mode_wot() },
  ];

  /** One tap on a choice opens the review sheet; Apply is the second tap. */
  function setMode(id: AccessMode) {
    if (!relayCfg || id === mode || configFlow.busy) return;
    const label = WHO.find((w) => w.id === id)?.label() ?? id;
    void configFlow.propose({ merge: { access: { mode: id } }, summary: m.tt_who_summary({ mode: label }) }, { relay: true });
  }

  /** Releasing a slider (or a short pause after arrow keys) opens the review sheet: no separate Save. */
  function goalCommit() {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => void proposeGoals(), 350);
  }
  async function proposeGoals() {
    if (!goals || !saved || !goalsDiffer(goals, saved) || configFlow.busy || configFlow.current) return;
    proposingGoals = true;
    const ok = await configFlow.propose({ merge: { goals: { ...goals } }, summary: m.goals_summary() }, { relay: true });
    if (!ok) {
      proposingGoals = false;
      goals = { ...saved };
    }
  }
  // Review sheet closed (applied or cancelled): show the saved values again.
  $effect(() => {
    if (proposingGoals && !configFlow.current && !configFlow.busy) {
      proposingGoals = false;
      untrack(() => void loadRelay());
    }
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

  {#if relayCfg}
    <section class="rounded-xl border p-4" aria-labelledby="who-title" data-testid="who-can-post">
      <h2 id="who-title" class="text-sm font-medium">{m.access_who_can_post()}</h2>
      <div class="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-labelledby="who-title">
        {#each WHO as w (w.id)}
          <button
            type="button"
            role="radio"
            aria-checked={mode === w.id}
            class={cn('rounded-md px-1 py-2 text-xs leading-tight', mode === w.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            onclick={() => setMode(w.id)}
            data-testid={`who-${w.id}`}
          >
            {w.label()}
          </button>
        {/each}
      </div>
      <p class="mt-2 text-xs text-muted-foreground" data-testid="who-current">{WHO.find((w) => w.id === mode)?.long() ?? ''}</p>
      <ItemLens lines={[`relay.access.mode = ${mode}`]} />
    </section>
  {/if}

  <section class="rounded-xl border p-4" aria-labelledby="goals-title" data-testid="settings-goals">
    <div class="flex items-center gap-2">
      <Gauge class="size-4 text-primary" />
      <h2 id="goals-title" class="flex-1 text-sm font-medium">{m.settings_goals_title()}</h2>
      <a href={to('/settings/goals')} class="flex items-center text-xs text-primary" data-testid="goals-link">
        {m.tt_goals_details()}<ChevronRight class="size-3.5" />
      </a>
    </div>
    {#if goals}
      <p class="mt-1 text-xs text-muted-foreground">{m.tt_goals_hint()}</p>
      <div class="mt-3 space-y-2">
        {#each GOALS as g (g.key)}
          <div data-goal-quick={g.key}>
            <div class="flex items-baseline justify-between text-xs">
              <span>{g.title()}</span>
              <span class="tabular-nums text-muted-foreground">{goals[g.key]}</span>
            </div>
            <Slider bind:value={goals[g.key]} label={g.title()} disabled={proposingGoals} onValueCommit={goalCommit} />
          </div>
        {/each}
      </div>
      <ItemLens lines={[`relay.goals = ${JSON.stringify(saved ?? goals)}`]} />
    {:else}
      <p class="mt-1 text-xs text-muted-foreground">{m.settings_goals_desc()}</p>
    {/if}
  </section>

  <section aria-labelledby="sections-title">
    <h2 id="sections-title" class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.settings_sections()}</h2>
    <ul class="divide-y overflow-hidden rounded-xl border">
      {#each SECTIONS as s (s.id)}
        {@const Icon = icons[s.icon] ?? Info}
        <li class="flex items-center">
          <a href={to(`/settings/${s.id}`)} class="flex min-w-0 flex-1 items-center gap-3 p-3.5 hover:bg-muted/40" data-testid={`section-${s.id}`}>
            <Icon class="size-4 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm">{sectionTitle(s.id)}</span>
              <span class="block truncate text-xs text-muted-foreground">{sectionSummary(s.id)}</span>
            </span>
            <ChevronRight class="size-4 text-muted-foreground" />
          </a>
          {#if s.id === 'backups' && canBackUp}
            <Button size="sm" variant="secondary" class="mr-3 shrink-0" disabled={backingUp} onclick={backUpNow} data-testid="settings-backup-now">
              {m.backups_now()}
            </Button>
          {/if}
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
      <li>
        <a href={to('/settings/system')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40" data-testid="system-link">
          <HeartPulse class="size-4 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm">{m.system_title()}</span>
            <span class="block truncate text-xs text-muted-foreground">{m.system_summary()}</span>
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
