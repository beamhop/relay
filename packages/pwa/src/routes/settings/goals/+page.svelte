<script lang="ts">
  /**
   * Goals instead of knobs (§6.7): five sliders; Beamhop derives the exact
   * limits. "What this changes" comes from `policy.explain-limits` (current
   * values) and the shared goals engine (values after the move). Saving goes
   * through propose → plain diff → apply → 5-minute undo.
   */
  import { onMount } from 'svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { explainLimits } from '$goals';
  import { app } from '$lib/stores/app.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import { configFlow } from '$lib/stores/config.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import type { Goals, LimitExplanation, RelayConfig } from '$lib/api/types';
  import { to } from '$lib/nav';
  import Slider from '$lib/components/ui/slider.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type GoalKey = keyof Goals;
  const GOALS: Array<{ key: GoalKey; title: () => string; low: () => string; high: () => string; invert: boolean }> = [
    { key: 'openness', title: () => m.goal_openness(), low: () => m.goal_openness_low(), high: () => m.goal_openness_high(), invert: false },
    { key: 'spamTolerance', title: () => m.goal_spam(), low: () => m.goal_spam_low(), high: () => m.goal_spam_high(), invert: false },
    { key: 'storage', title: () => m.goal_storage(), low: () => m.goal_storage_low(), high: () => m.goal_storage_high(), invert: false },
    { key: 'media', title: () => m.goal_media(), low: () => m.goal_media_low(), high: () => m.goal_media_high(), invert: false },
    { key: 'speedVsCost', title: () => m.goal_speed(), low: () => m.goal_speed_low(), high: () => m.goal_speed_high(), invert: false },
  ];

  let relay = $state<RelayConfig | null>(null);
  let saved = $state<Goals | null>(null);
  let goals = $state<Goals | null>(null);
  let current = $state<LimitExplanation[]>([]);
  let focus = $state<GoalKey>('openness');

  async function load() {
    const r = await app.api.relayConfig();
    relay = r.relay;
    saved = { ...r.relay.goals };
    goals = { ...r.relay.goals };
    const ex = await query<{ lines: LimitExplanation[] }>('policy.explain-limits', {});
    current = ex?.lines ?? safeExplain(r.relay);
  }
  onMount(load);

  function safeExplain(rc: RelayConfig): LimitExplanation[] {
    try {
      return explainLimits(rc as never) as LimitExplanation[];
    } catch {
      return [];
    }
  }

  /** Lines after the move, computed locally with the same goals engine as the server. */
  const after = $derived(relay && goals ? safeExplain({ ...relay, goals: { ...goals } }) : []);
  const dirty = $derived(!!saved && !!goals && GOALS.some((g) => saved![g.key] !== goals![g.key]));

  const changes = $derived.by(() => {
    const before = new Map(current.map((l) => [l.field, l]));
    return after
      .filter((l) => {
        const b = before.get(l.field);
        return b && JSON.stringify(b.value) !== JSON.stringify(l.value);
      })
      .map((l) => ({ before: before.get(l.field)!, after: l }));
  });

  const explainFor = (k: GoalKey) => current.filter((l) => l.goal === k);

  async function save() {
    if (!goals) return;
    await configFlow.propose(
      { merge: { goals: { ...goals } }, summary: m.goals_summary() },
      {
        relay: true,
        onApplied: () => {
          void load();
        },
      },
    );
  }

  function reset() {
    if (saved) goals = { ...saved };
  }

  const strip = (t: string) => t.split(' — ')[0] ?? t;
</script>

<svelte:head><title>{m.settings_goals_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.settings_goals_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.goals_intro()}</p>

{#if !goals}
  <div class="mt-6 space-y-4">{#each GOALS as g (g.key)}<Skeleton class="h-16 w-full" />{/each}</div>
{:else}
  <div class="mt-6 md:grid md:grid-cols-[1fr_320px] md:gap-8">
    <div class="space-y-6" data-testid="goal-sliders">
      {#each GOALS as g (g.key)}
        <div class="rounded-xl border p-4" data-goal={g.key}>
          <div class="flex items-baseline justify-between">
            <h2 class="text-sm font-medium">{g.title()}</h2>
            <span class="text-xs tabular-nums text-muted-foreground">{goals[g.key]}{saved && saved[g.key] !== goals[g.key] ? ` (${m.goals_was({ value: saved[g.key] })})` : ''}</span>
          </div>
          <Slider
            bind:value={goals[g.key]}
            label={g.title()}
            data-setting-input
            onfocusin={() => (focus = g.key)}
            onpointerdown={() => (focus = g.key)}
          />
          <div class="flex justify-between text-[11px] text-muted-foreground">
            <span>{g.low()}</span><span>{g.high()}</span>
          </div>
          {#if focus === g.key && explainFor(g.key).length}
            <ul class="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground" data-testid="goal-explain">
              {#each explainFor(g.key) as l (l.field)}
                <li>{strip(l.text)}{#if prefs.lens}<span class="block font-mono text-[10px]" data-lens>{l.technical}</span>{/if}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </div>

    <aside class="mt-6 md:mt-0" aria-live="polite">
      <div class="sticky top-20 rounded-xl border bg-card p-4" data-testid="goal-changes">
        <h2 class="text-sm font-medium">{m.goals_what_changes()}</h2>
        {#if changes.length === 0}
          <p class="mt-2 text-sm text-muted-foreground">{dirty ? m.goals_no_effect() : m.goals_move_hint()}</p>
        {:else}
          <ul class="mt-3 space-y-2 text-sm">
            {#each changes as c (c.after.field)}
              <li class="rounded-lg bg-muted/50 p-2">
                <p class="text-muted-foreground line-through decoration-muted-foreground/50">{strip(c.before.text)}</p>
                <p class="flex items-start gap-1"><ArrowRight class="mt-0.5 size-3.5 shrink-0 text-primary" />{strip(c.after.text)}</p>
                {#if prefs.lens}<p class="mt-1 font-mono text-[10px] text-muted-foreground" data-lens>{c.after.technical}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
        <div class="mt-4 flex gap-2">
          <Button variant="secondary" class="flex-1" disabled={!dirty} onclick={reset}>{m.common_reset()}</Button>
          <Button class="flex-1" disabled={!dirty || configFlow.busy} onclick={save} data-testid="goals-save">{m.common_save()}</Button>
        </div>
        <a href={to('/settings/advanced')} class="mt-3 block text-center text-xs text-muted-foreground">{m.goals_see_exact()}</a>
      </div>
    </aside>
  </div>
{/if}
