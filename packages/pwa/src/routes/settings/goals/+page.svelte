<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Goals instead of knobs (§6.7): five sliders; Beamhop derives the exact
   * limits. "What this changes" comes from `policy.explain-limits` (current
   * values) and the shared goals engine (values after the move). Saving goes
   * through propose → plain diff → apply → 5-minute undo.
   *
   * Advanced (§6.7): every exact value shows which goal produced it; values
   * the admin overrode are marked "Changed by you" with a way back to the
   * goal's value, and each slider counts its overridden values.
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
  import Badge from '$lib/components/ui/badge.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { goalLines, overrideCounts, revertOverride, type GoalLine } from './overrides';
  import { GOALS, type GoalKey } from '$lib/settings/goals';
  import { m } from '$lib/paraglide/messages.js';

  let relay = $state<RelayConfig | null>(null);
  let saved = $state<Goals | null>(null);
  let goals = $state<Goals | null>(null);
  let current = $state<LimitExplanation[]>([]);
  let focus = $state<GoalKey>('openness');
  let advancedOpen = $state(false);

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

  /** "3 people would be over their new limit": the server's what-if for storage and media goals. */
  let impact = $state<{ nearQuota: number; overQuota: number } | null>(null);
  $effect(() => {
    const g = goals;
    const s = saved;
    if (!g || !s || !app.hasAction('policy.explain-limits')) return;
    if (g.storage === s.storage && g.media === s.media) {
      impact = null;
      return;
    }
    const what = { storage: g.storage, media: g.media };
    const t = setTimeout(async () => {
      const r = await query<{ quotaImpact?: { nearQuota: number; overQuota: number } }>('policy.explain-limits', {
        goals: what,
      });
      impact = r?.quotaImpact ?? null;
    }, 250);
    return () => clearTimeout(t);
  });

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

  /** Exact values with where each one comes from (local goals engine, same as the server). */
  const exact = $derived<GoalLine[]>(relay ? goalLines(relay, safeExplain) : []);
  const overrides = $derived(overrideCounts(exact));
  const goalTitle = (k: GoalKey) => GOALS.find((g) => g.key === k)?.title() ?? k;

  async function revert(l: GoalLine) {
    await configFlow.propose(
      { merge: revertOverride(l.field), summary: m.goalov_revert_summary() },
      {
        relay: true,
        onApplied: () => {
          void load();
        },
      },
    );
  }
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
          {#if overrides[g.key]}
            <a href="#exact-values" class="mt-2 inline-flex items-center gap-1 text-xs text-warning" data-testid="goal-overrides" onclick={() => (advancedOpen = true)}>
              {overrides[g.key] === 1 ? m.goalov_count_one() : m.goalov_count({ count: overrides[g.key] ?? 0 })}
            </a>
          {/if}
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
        {#if dirty && impact && (impact.overQuota > 0 || impact.nearQuota > 0)}
          <div class="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-2 text-sm" data-testid="quota-impact">
            {#if impact.overQuota > 0}
              <p>{impact.overQuota === 1 ? m.goals_quota_over_one() : m.goals_quota_over({ count: impact.overQuota })}</p>
            {/if}
            {#if impact.nearQuota > 0}
              <p class="text-xs text-muted-foreground">
                {impact.nearQuota === 1 ? m.goals_quota_near_one() : m.goals_quota_near({ count: impact.nearQuota })}
              </p>
            {/if}
          </div>
        {/if}
        <div class="mt-4 flex gap-2">
          <Button variant="secondary" class="flex-1" disabled={!dirty} onclick={reset}>{m.common_reset()}</Button>
          <Button class="flex-1" disabled={!dirty || configFlow.busy} onclick={save} data-testid="goals-save">{m.common_save()}</Button>
        </div>
        <a href={to('/settings/advanced')} class="mt-3 block text-center text-xs text-muted-foreground">{m.goals_see_exact()}</a>
      </div>
    </aside>
  </div>

  <details id="exact-values" class="mt-6 scroll-mt-20 rounded-xl border p-4" bind:open={advancedOpen} data-testid="goal-exact">
    <summary class="cursor-pointer text-sm font-medium">{m.goalov_advanced_title()}</summary>
    <p class="mt-2 text-xs text-muted-foreground">{m.goalov_advanced_hint()}</p>
    <ul class="mt-3 divide-y text-sm">
      {#each exact as l (l.field)}
        <li class="py-2.5" data-testid="exact-row" data-field={l.field} data-source={l.source}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="min-w-0 flex-1">{l.text}</span>
            {#if l.source === 'override'}<Badge tone="warn">{m.goalov_changed()}</Badge>{/if}
          </div>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {#if l.source === 'goal' && l.goal}{m.goalov_from_goal({ goal: goalTitle(l.goal) })}
            {:else if l.source === 'override' && l.goalText}{m.goalov_goal_would({ text: l.goalText })}
            {:else if l.source === 'tier'}{m.goalov_from_tier()}
            {:else if l.source === 'setting'}{m.goalov_from_setting()}
            {:else}{m.goalov_fixed()}{/if}
          </p>
          {#if l.source === 'override' && l.revertible}
            <Button size="sm" variant="secondary" class="mt-2" disabled={configFlow.busy} onclick={() => revert(l)} data-testid="goal-revert">{m.goalov_revert()}</Button>
          {/if}
          <ItemLens lines={[l.technical, `source: ${l.source}${l.fromGoal ? ` (goals.${l.fromGoal})` : ''}`]} />
        </li>
      {/each}
    </ul>
  </details>
{/if}
