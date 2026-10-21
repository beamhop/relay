<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Refused posts (§6.10): the latest posts the relay turned away or held,
   * each with "Why?", plus the people who are blocked or muted, each with
   * "Why?" too. Multi-select → block authors (§6.13).
   */
  import { onMount } from 'svelte';
  import ShieldX from '@lucide/svelte/icons/shield-x';
  import { app } from '$lib/stores/app.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { ago, cn } from '$lib/utils';
  import WhyButton from '../WhyButton.svelte';
  import ItemLens from '../ItemLens.svelte';
  import Badge from '../ui/badge.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import NotesButton from '../notes/NotesButton.svelte';
  import BulkActions from './BulkActions.svelte';
  import { longpress } from './longpress';
  import { selectRange, type Pick } from './bulk';
  import { m } from '$lib/paraglide/messages.js';

  interface Refusal {
    relayId: string;
    eventId: string;
    pubkey: string;
    kind: number;
    reason: string;
    by?: string;
    at: number;
    decision: 'reject' | 'hold';
  }
  interface Person {
    pubkey: string;
    reason?: string;
    at: number;
    until?: number;
    muted?: boolean;
  }

  let items = $state<Refusal[] | null>(null);
  let people = $state<Person[]>([]);
  let selecting = $state(false);
  let selected = $state<Set<string>>(new Set());
  let anchor: string | null = null;

  async function load() {
    const [r, banned, muted] = await Promise.all([
      query<{ items: Refusal[] }>('experience.recent-rejections', { limit: 100 }),
      query<{ pubkeys: Person[] }>('moderation.list-banned-pubkeys'),
      query<{ pubkeys: Person[] }>('moderation.list-muted-pubkeys'),
    ]);
    items = r?.items ?? [];
    people = [...(banned?.pubkeys ?? []), ...(muted?.pubkeys ?? []).map((p) => ({ ...p, muted: true }))].slice(0, 30);
  }
  onMount(load);

  let lastTick = live.tick;
  $effect(() => {
    if (live.tick !== lastTick) {
      lastTick = live.tick;
      if (!selecting) void load();
    }
  });

  const key = (r: Refusal) => `${r.eventId}:${r.at}`;
  function toggle(r: Refusal, e?: MouseEvent) {
    selecting = true;
    selected = selectRange(selected, (items ?? []).map(key), anchor, key(r), !!e?.shiftKey);
    anchor = key(r);
  }
  function stop() {
    selecting = false;
    selected = new Set();
    anchor = null;
  }
  function afterBulk(_kind: string, pending: boolean) {
    if (pending) return;
    stop();
    void load();
  }
  const picks = $derived<Pick[]>(
    (items ?? []).filter((r) => selected.has(key(r))).map((r) => ({ eventId: r.eventId, pubkey: r.pubkey })),
  );
  const canModerate = $derived(app.can('moderation.write'));
</script>

{#if items === null}
  <Skeleton class="h-40 w-full" />
{:else}
  {#if selecting}
    <BulkActions {picks} kinds={['remove', 'ban']} oncancel={stop} ondone={afterBulk} />
  {/if}
  {#if items.length === 0}
    <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="refused-empty">{m.act_refused_empty()}</p>
  {:else}
    <ul class="divide-y rounded-xl border" data-testid="refused-list">
      {#each items as r (key(r))}
        <li
          class={cn('flex items-start gap-3 p-3', selected.has(key(r)) && 'bg-primary/5')}
          use:longpress={{ onlongpress: () => toggle(r), enabled: canModerate }}
          data-testid="refused-row"
        >
          {#if canModerate}
            <input
              type="checkbox"
              class={cn('mt-1 size-4 shrink-0', !selecting && 'hidden md:block')}
              checked={selected.has(key(r))}
              onclick={(e) => {
                e.preventDefault();
                toggle(r, e);
              }}
              aria-label={m.common_select()}
            />
          {/if}
          <div class="min-w-0 flex-1">
            <p class="text-sm">{names.text(r.reason)}</p>
            <p class="text-xs text-muted-foreground">
              <Badge tone={r.decision === 'hold' ? 'warn' : 'critical'}>{r.decision === 'hold' ? m.act_refused_held() : m.act_refused_rejected()}</Badge>
              {names.label(r.pubkey)} · {ago(r.at)}
            </p>
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <WhyButton subject={{ subject: 'rejected-event', eventId: r.eventId }} />
              <NotesButton subject={{ type: 'event', id: r.eventId }} />
            </div>
            <ItemLens lines={[`kind ${r.kind} · ${r.eventId}`, `pubkey ${r.pubkey}`, ...(r.by ? [`by ${r.by}`] : [])]} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if people.length}
    <h2 class="mb-2 mt-6 flex items-center gap-2 text-sm font-medium"><ShieldX class="size-4" />{m.act_blocked_title()}</h2>
    <ul class="divide-y rounded-xl border" data-testid="blocked-list">
      {#each people as p (p.pubkey + (p.muted ? ':m' : ''))}
        <li class="flex items-start gap-3 p-3">
          <div class="min-w-0 flex-1">
            <p class="text-sm">{names.label(p.pubkey)}</p>
            <p class="text-xs text-muted-foreground">
              {p.muted ? m.act_blocked_muted() : m.act_blocked_blocked()} · {ago(p.at)}{p.reason ? ` · ${names.text(p.reason)}` : ''}
            </p>
            <div class="mt-1 flex items-center gap-2">
              <WhyButton subject={{ subject: 'block', pubkey: p.pubkey }} />
              <NotesButton subject={{ type: 'pubkey', id: p.pubkey }} />
            </div>
            <ItemLens lines={[`pubkey ${p.pubkey}`, ...(p.until ? [`until ${new Date(p.until * 1000).toISOString()}`] : [])]} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
