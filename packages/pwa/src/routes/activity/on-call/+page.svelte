<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * On-call schedule (§6.12): admins take turns; alerts and urgent
   * suggestions go to whoever is on duty. The list starts with the turn
   * running now and repeats. Tap a turn to choose who is on duty.
   * Saves with `alerts.set-oncall` (preview → apply → undo).
   */
  import { onMount } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import UserRound from '@lucide/svelte/icons/user-round';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import { to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import Sheet from '$lib/components/Sheet.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { admins } from '$lib/components/activity/admins.svelte';
  import {
    type OnCallSchedule,
    type Turn,
    assign,
    toSchedule,
    upcoming,
  } from '$lib/components/activity/oncall';
  import { m } from '$lib/paraglide/messages.js';

  let prev = $state<OnCallSchedule | null>(null);
  let turns = $state<Turn[] | null>(null);
  let periodDays = $state(7);
  let channels = $state<string[]>([]);
  let picking = $state<number | null>(null);
  let pickOpen = $state(false);
  const now = Math.floor(Date.now() / 1000);

  const available = $derived(app.hasAction('alerts.set-oncall'));
  const canEdit = $derived(app.can('admins.manage', false));

  async function load() {
    const [r, cfg] = await Promise.all([
      query<{ schedule: OnCallSchedule | null }>('alerts.oncall'),
      app.api.config().catch(() => null),
      admins.ensure(),
    ]);
    channels = (cfg?.config.alerts?.channels ?? []).map((c) => c.id);
    prev = r?.schedule ?? null;
    periodDays = prev?.periodDays ?? 7;
    turns = upcoming(prev, now).map((s) => s.turn);
  }
  onMount(load);

  /** Dates of each displayed turn (starting with the one running now). */
  const dates = $derived.by(() => {
    if (!turns?.length) return [];
    const sched = toSchedule(turns, periodDays, now, prev);
    return upcoming(sched, now);
  });

  const fmt = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const label = (offset: number) =>
    offset === 0
      ? periodDays < 7
        ? m.act_oncall_today()
        : m.act_oncall_this_week()
      : offset === 1
        ? periodDays < 7
          ? m.act_oncall_tomorrow()
          : m.act_oncall_next_week()
        : m.act_oncall_later({ when: fmt(dates[offset]?.start ?? now) });

  function openPicker(offset: number | null) {
    picking = offset;
    pickOpen = true;
  }

  function choose(id: string) {
    const list = turns ?? [];
    turns = picking === null ? [...list, { principalId: id, channels: [...channels] }] : assign(list, picking, id, channels);
    pickOpen = false;
  }

  function removeTurn(offset: number) {
    turns = (turns ?? []).filter((_, i) => i !== offset);
  }

  function save() {
    const def = app.action('alerts.set-oncall');
    if (!def || !turns) return;
    const s = toSchedule(turns, periodDays, now, prev);
    void flow.start(def, { rotation: s.rotation, periodDays: s.periodDays, startAt: s.startAt }, { onDone: () => void load(), onUndo: () => void load() });
  }

  const missingChannels = $derived((turns ?? []).some((t) => t.channels.length === 0));
</script>

<svelte:head><title>{m.act_oncall_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/activity?tab=alerts')} class="text-sm text-muted-foreground">← {m.activity_tab_alerts()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.act_oncall_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.act_oncall_desc()}</p>

{#if !available}
  <p class="mt-6 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{m.act_oncall_unavailable()}</p>
{:else if turns === null}
  <Skeleton class="mt-4 h-40 w-full" />
{:else}
  <div class="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label={m.act_oncall_period()}>
    {#each [1, 7] as d (d)}
      <button
        type="button"
        role="radio"
        aria-checked={periodDays === d}
        disabled={!canEdit}
        class={cn('rounded-lg border px-3 py-2 text-sm', periodDays === d ? 'border-foreground bg-muted font-medium' : 'text-muted-foreground')}
        onclick={() => (periodDays = d)}
        data-testid={`oncall-period-${d}`}
      >
        {d === 1 ? m.act_oncall_daily() : m.act_oncall_weekly()}
      </button>
    {/each}
  </div>

  {#if turns.length === 0}
    <p class="mt-4 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="oncall-empty">{m.act_oncall_empty()}</p>
  {:else}
    <ol class="mt-4 divide-y rounded-xl border" data-testid="oncall-turns">
      {#each turns as t, i (i)}
        <li class={cn('flex items-center gap-3 p-3', i === 0 && 'bg-primary/5')} data-testid="oncall-turn">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            disabled={!canEdit}
            onclick={() => openPicker(i)}
            data-testid="oncall-assign"
          >
            <UserRound class="size-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block text-xs text-muted-foreground">{label(i)}{dates[i] ? ` · ${fmt(dates[i].start)} – ${fmt(dates[i].end - 1)}` : ''}</span>
              <span class="block text-sm font-medium" data-testid="oncall-name">{admins.name(t.principalId)}</span>
              <ItemLens lines={[`principal ${t.principalId}`, `channels ${t.channels.join(', ') || '—'}`]} />
            </span>
          </button>
          {#if canEdit}
            <button type="button" class="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label={m.act_oncall_remove()} onclick={() => removeTurn(i)}>
              <X class="size-4" />
            </button>
          {/if}
        </li>
      {/each}
    </ol>
    <p class="mt-2 text-xs text-muted-foreground">{m.act_oncall_repeats()}</p>
  {/if}

  {#if canEdit}
    <Button variant="secondary" class="mt-4 w-full md:w-auto" onclick={() => openPicker(null)} data-testid="oncall-add"><Plus class="size-4" />{m.act_oncall_add()}</Button>
    {#if channels.length === 0}
      <p class="mt-3 text-sm text-warning" data-testid="oncall-no-channels">
        {m.act_oncall_no_channels()} <a class="text-primary" href={to('/settings/alerts')}>{m.alerts_configure()}</a>
      </p>
    {/if}
    <Button class="mt-4 w-full" disabled={missingChannels || (turns.length === 0 && !prev)} onclick={save} data-testid="oncall-save">{m.common_save()}</Button>
  {/if}
{/if}

<Sheet bind:open={pickOpen} title={m.act_oncall_pick()} testid="oncall-picker">
  <ul class="divide-y">
    {#each admins.list as a (a.id)}
      <li>
        <button type="button" class="flex w-full items-center gap-3 py-3 text-left text-sm" onclick={() => choose(a.id)} data-testid="oncall-pick">
          <UserRound class="size-4 text-muted-foreground" />{admins.name(a.id)}
        </button>
      </li>
    {/each}
  </ul>
</Sheet>
