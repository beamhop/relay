<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Swipe triage (§5.3, §6.2): → keep, ← remove, ↑ block author, ↓ skip.
   * Every decision runs at once and shows an undo toast. Keyboard:
   * e keep · x remove · # block · j / s skip · k back · u undo.
   * Desktop: split pane, the waiting items on the left (click to review one).
   */
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Ban from '@lucide/svelte/icons/ban';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import Flag from '@lucide/svelte/icons/flag';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import ListChecks from '@lucide/svelte/icons/list-checks';
  import type { QueueItem, RunResult } from '$lib/api/types';
  import type { Direction } from '$lib/gestures/recognizer';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { assistant } from '$lib/stores/assistant.svelte';
  import { haptic } from '$lib/haptics';
  import { ago } from '$lib/utils';
  import { names } from '$lib/stores/names.svelte';
  import SwipeCard from '../SwipeCard.svelte';
  import ItemLens from '../ItemLens.svelte';
  import NotesButton from '../notes/NotesButton.svelte';
  import BulkActions from './BulkActions.svelte';
  import { longpress } from './longpress';
  import { selectRange, type Pick } from './bulk';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let items = $state<QueueItem[] | null>(null);
  let skipped = $state<QueueItem[]>([]);
  let error = $state<string | null>(null);
  let card: SwipeCard | undefined = $state();
  let busy = $state(false);

  /** AI pre-label for a queue item (§5.3): a hint only, never applied by itself. */
  interface AiLabel {
    itemId: string;
    status: 'labeled' | 'failed';
    label?: 'spam' | 'abuse' | 'ok';
    reason?: string;
    model?: string;
    at: number;
  }
  let labels = $state<Record<string, AiLabel>>({});
  const asked = new Set<string>();
  const aiOn = $derived(app.hasAction('ai.moderation-labels'));

  /** Multi-select (§6.13): long-press on phone, Select button / checkboxes / shift-click on desktop. */
  let selecting = $state(false);
  let selected = $state<Set<string>>(new Set());
  let anchor: string | null = null;

  const top = $derived(items?.[0]);
  const canModerate = $derived(app.can('moderation.write'));

  async function load() {
    error = null;
    try {
      const r = await app.api.run<{ items: QueueItem[]; total: number }>('moderation.queue', {
        status: 'pending',
        limit: 200,
      });
      const skippedIds = new Set(skipped.map((s) => s.id));
      const fresh = r.output.items.filter((i) => !skippedIds.has(i.id));
      items = [...fresh, ...r.output.items.filter((i) => skippedIds.has(i.id))];
    } catch (err) {
      error = asApiError(err).message;
      items = [];
    }
  }

  onMount(load);

  /** Fetch AI hints in one batch for the items on screen (top of the stack + the list). */
  async function fetchLabels(ids: string[]) {
    const want = ids.filter((id) => !asked.has(id));
    if (!want.length) return;
    for (const id of want) asked.add(id);
    try {
      const r = await app.api.run<{ labels: AiLabel[] }>('ai.moderation-labels', { ids: want }, 'relay');
      const next = { ...labels };
      for (const l of r.output.labels) if (l.status === 'labeled' && l.label) next[l.itemId] = l;
      labels = next;
    } catch {
      for (const id of want) asked.delete(id);
    }
  }

  $effect(() => {
    if (!aiOn || !items?.length) return;
    void fetchLabels(items.slice(0, 20).map((i) => i.id));
  });

  const aiText = (l: AiLabel) =>
    l.label === 'spam' ? m.act_ai_spam() : l.label === 'abuse' ? m.act_ai_abuse() : m.act_ai_ok();

  function toggleSelect(item: QueueItem, e?: MouseEvent) {
    selected = selectRange(selected, (items ?? []).map((i) => i.id), anchor, item.id, !!e?.shiftKey);
    anchor = item.id;
  }

  function startSelecting(item?: QueueItem) {
    selecting = true;
    selected = new Set(item ? [item.id] : []);
    anchor = item?.id ?? null;
  }

  function stopSelecting() {
    selecting = false;
    selected = new Set();
    anchor = null;
  }

  const picks = $derived<Pick[]>(
    (items ?? [])
      .filter((i) => selected.has(i.id))
      .map((i) => {
        const p: Pick = { itemId: i.id };
        const ev = i.eventId ?? i.event?.id;
        if (ev) p.eventId = ev;
        const pk = i.pubkey ?? i.event?.pubkey;
        if (pk) p.pubkey = pk;
        return p;
      }),
  );

  function afterBulk(_kind: string, pending: boolean) {
    if (!pending) stopSelecting();
    void load();
  }

  const lensLines = (i: QueueItem): string[] => {
    const out: string[] = [];
    if (i.technical) out.push(i.technical);
    if (i.event) out.push(`kind ${i.event.kind} · ${i.event.id}`);
    if (i.sha256) out.push(`sha256 ${i.sha256}`);
    const l = labels[i.id];
    if (l) out.push(`AI hint: ${l.label}${l.model ? ` · model ${l.model}` : ''} · ${new Date(l.at * 1000).toISOString()}`);
    return out;
  };

  let lastTick = live.tick;
  $effect(() => {
    if (live.tick !== lastTick) {
      lastTick = live.tick;
      if (!busy && (items?.length ?? 0) < 3) void load();
    }
  });

  function pop(item: QueueItem) {
    items = (items ?? []).filter((i) => i.id !== item.id);
  }

  function restore(item: QueueItem) {
    items = [item, ...(items ?? []).filter((i) => i.id !== item.id)];
  }

  /** Run one or more actions; a single undo reverts all of them (newest first). */
  async function decide(item: QueueItem, steps: Array<{ id: string; input: unknown }>, message: string) {
    busy = true;
    pop(item);
    const tokens: string[] = [];
    try {
      for (const s of steps) {
        const r: RunResult = await app.api.run(s.id, s.input, 'relay');
        if (r.undo) tokens.push(r.undo.token);
      }
      haptic('success');
      toasts.success(message, tokens.length
        ? async () => {
            try {
              for (const t of [...tokens].reverse()) await app.api.undo(t);
              restore(item);
              toasts.show({ message: m.toast_undone({ what: message }), kind: 'info' });
            } catch (err) {
              const e = asApiError(err);
              toasts.error(e.message, e.technical);
              void load();
            }
          }
        : undefined);
    } catch (err) {
      restore(item);
      const e = asApiError(err);
      haptic('warning');
      toasts.error(e.message, e.technical);
    } finally {
      busy = false;
    }
  }

  function keep(item: QueueItem) {
    void decide(item, [{ id: 'moderation.keep', input: { itemIds: [item.id] } }], m.mod_kept());
  }
  function remove(item: QueueItem) {
    void decide(item, [{ id: 'moderation.remove', input: { itemIds: [item.id] } }], m.mod_removed());
  }
  function ban(item: QueueItem) {
    const pk = item.pubkey ?? item.event?.pubkey;
    if (!pk) {
      remove(item);
      return;
    }
    void decide(
      item,
      [
        { id: 'moderation.ban-pubkey', input: { pubkeys: [pk] } },
        { id: 'moderation.remove', input: { itemIds: [item.id] } },
      ],
      m.mod_banned(),
    );
  }
  function skip(item: QueueItem) {
    haptic('tap');
    skipped = [...skipped.filter((s) => s.id !== item.id), item];
    items = [...(items ?? []).filter((i) => i.id !== item.id), item];
  }
  function back() {
    const prev = skipped[skipped.length - 1];
    if (!prev) return;
    skipped = skipped.slice(0, -1);
    restore(prev);
  }

  /** Review this item next (desktop list). */
  function pick(item: QueueItem) {
    if (item.id === top?.id) return;
    skipped = skipped.filter((s) => s.id !== item.id);
    restore(item);
  }

  // The assistant gets the item under review as context.
  $effect(() => {
    assistant.setSelection(
      top ? { queueItem: top.id, type: top.type, reason: top.reason, eventId: top.eventId, pubkey: top.pubkey } : undefined,
    );
    return () => assistant.setSelection(undefined);
  });

  function onswipe(d: Direction) {
    const item = top;
    if (!item) return;
    if (d === 'right') keep(item);
    else if (d === 'left') remove(item);
    else if (d === 'up') ban(item);
    else skip(item);
  }

  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('[role="dialog"]')) return;
    if (!top || !canModerate || selecting) return;
    const map: Record<string, Direction | 'back'> = { e: 'right', x: 'left', '#': 'up', j: 'down', s: 'down', k: 'back' };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    if (d === 'back') back();
    else card?.fling(d);
  }

  const typeLabel = (i: QueueItem) =>
    i.type === 'report' ? m.mod_type_report() : i.type === 'blob' ? m.mod_type_file() : m.mod_type_post();
</script>

<svelte:window {onkeydown} />

<section aria-label={m.activity_tab_queue()} data-testid="moderation-queue">
  {#if items === null}
    <Skeleton class="h-64 w-full" />
  {:else if error}
    <p class="text-sm text-destructive">{error}</p>
  {:else if !top}
    <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center" data-testid="queue-empty">
      <CircleCheck class="size-8 text-success" />
      <p class="font-medium">{m.mod_empty_title()}</p>
      <p class="text-sm text-muted-foreground">{m.mod_empty_body()}</p>
    </div>
  {:else}
    <div class="mb-3 flex items-center gap-2">
      <p class="flex-1 text-xs text-muted-foreground" data-testid="queue-count">{m.mod_remaining({ count: items.length })}</p>
      {#if canModerate && !selecting}
        <Button size="sm" variant="ghost" onclick={() => startSelecting()} data-testid="queue-select">
          <ListChecks class="size-4" />{m.common_select()}
        </Button>
      {/if}
    </div>
    {#if selecting}
      <BulkActions {picks} oncancel={stopSelecting} ondone={afterBulk} />
      <ul class="divide-y rounded-xl border" data-testid="queue-select-list">
        {#each items as item (item.id)}
          {@const l = labels[item.id]}
          <li>
            <label class="flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm hover:bg-muted/50">
              <input
                type="checkbox"
                class="mt-0.5 size-4"
                checked={selected.has(item.id)}
                onclick={(e) => {
                  e.preventDefault();
                  toggleSelect(item, e);
                }}
                aria-label={item.reason}
                data-testid="queue-select-item"
              />
              <span class="min-w-0 flex-1">
                <span class="line-clamp-1 font-medium">{names.text(item.reason)}</span>
                <span class="line-clamp-1 text-xs text-muted-foreground">
                  {typeLabel(item)} · {names.label(item.pubkey ?? item.event?.pubkey)} · {ago(item.createdAt)}
                </span>
                {#if l}<span class="line-clamp-1 text-xs text-primary">{m.act_ai_suggested({ label: aiText(l) })}</span>{/if}
              </span>
            </label>
          </li>
        {/each}
      </ul>
    {:else}
    <div class="md:grid md:grid-cols-[minmax(220px,300px)_1fr] md:gap-6" data-testid="queue-split">
    <nav class="hidden max-h-[70dvh] overflow-y-auto rounded-xl border md:block" aria-label={m.mod_list()} data-testid="queue-list">
      <ul class="divide-y">
        {#each items as item (item.id)}
          {@const l = labels[item.id]}
          <li class="flex items-start">
            {#if canModerate}
              <input
                type="checkbox"
                class="ml-3 mt-3 size-4 shrink-0"
                checked={selected.has(item.id)}
                onclick={(e) => {
                  e.preventDefault();
                  selecting = true;
                  toggleSelect(item, e);
                }}
                aria-label={m.common_select()}
                data-testid="queue-list-check"
              />
            {/if}
            <button
              type="button"
              class="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50 aria-[current=true]:bg-muted"
              aria-current={item.id === top.id}
              data-testid="queue-list-item"
              onclick={() => pick(item)}
            >
              <span class="line-clamp-1 font-medium">{item.reason}</span>
              <span class="line-clamp-1 text-xs text-muted-foreground">{typeLabel(item)} · {ago(item.createdAt)}</span>
              {#if l}<span class="line-clamp-1 text-[11px] text-primary">{m.act_ai_suggested({ label: aiText(l) })}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </nav>
    <div>
    <div class="relative mx-auto max-w-lg">
      {#if items[1]}<div class="absolute inset-x-4 -bottom-2 h-full rounded-2xl border bg-card/50" aria-hidden="true"></div>{/if}
      {#key top.id}
        {@const hint = labels[top.id]}
        <SwipeCard
          bind:this={card}
          directions={canModerate ? ['left', 'right', 'up', 'down'] : ['down']}
          hints={{
            right: { label: m.mod_keep(), tone: 'ok' },
            left: { label: m.mod_remove(), tone: 'critical' },
            up: { label: m.mod_ban(), tone: 'critical' },
            down: { label: m.mod_skip(), tone: 'neutral' },
          }}
          {onswipe}
          testid="queue-card"
        >
          <article
            class="min-h-56 rounded-2xl border bg-card p-5 shadow-sm"
            use:longpress={{ onlongpress: () => startSelecting(top), enabled: canModerate }}
          >
            <div class="flex items-center gap-2">
              <Badge tone={top.type === 'report' ? 'warn' : 'neutral'}>{typeLabel(top)}</Badge>
              <span class="flex-1 text-xs text-muted-foreground">{ago(top.createdAt)}</span>
              {#if top.eventId ?? top.event?.id}
                <NotesButton subject={{ type: 'event', id: (top.eventId ?? top.event?.id) as string }} />
              {:else if top.sha256}
                <NotesButton subject={{ type: 'blob', id: top.sha256 }} />
              {/if}
            </div>
            <p class="mt-3 flex items-start gap-2 text-sm font-medium" data-testid="queue-reason">
              <Flag class="mt-0.5 size-4 shrink-0 text-warning" />{names.text(top.reason)}
            </p>
            {#if hint}
              <p
                class="mt-2 flex items-start gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-2.5 py-1.5 text-xs"
                data-testid="queue-ai-hint"
                data-label={hint.label}
              >
                <Sparkles class="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>
                  <span class="font-medium">{m.act_ai_suggested({ label: aiText(hint) })}</span>{hint.reason ? ` — ${hint.reason}` : ''}
                  <span class="block text-[11px] text-muted-foreground">{m.act_ai_only_hint()}</span>
                </span>
              </p>
            {/if}
            {#if top.event}
              <blockquote class="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 text-sm">
                {top.event.content || m.mod_no_text()}
              </blockquote>
            {/if}
            {#if top.reports?.length}
              <ul class="mt-3 space-y-1 text-xs text-muted-foreground">
                {#each top.reports.slice(0, 3) as r (r.reportId)}
                  <li>{m.mod_reported_for({ reason: r.type })}{r.comment ? ` — “${r.comment}”` : ''}</li>
                {/each}
              </ul>
            {/if}
            <p class="mt-3 text-xs text-muted-foreground">
              {m.mod_author()} <span data-testid="queue-author">{names.label(top.pubkey ?? top.event?.pubkey)}</span>
            </p>
            <div class="mt-2"><ItemLens lines={lensLines(top)} /></div>
          </article>
        </SwipeCard>
      {/key}
    </div>

    {#if canModerate}
      <div class="mx-auto mt-6 grid max-w-lg grid-cols-4 gap-2">
        <Button variant="secondary" class="h-14 flex-col gap-1 text-[11px]" onclick={() => card?.fling('left')} data-testid="triage-remove">
          <Trash2 class="size-4 text-destructive" />{m.mod_remove()} <kbd class="sr-only">x</kbd>
        </Button>
        <Button variant="secondary" class="h-14 flex-col gap-1 text-[11px]" onclick={() => card?.fling('up')} data-testid="triage-ban">
          <Ban class="size-4 text-destructive" />{m.mod_ban()}
        </Button>
        <Button variant="secondary" class="h-14 flex-col gap-1 text-[11px]" onclick={() => card?.fling('down')} data-testid="triage-skip">
          <SkipForward class="size-4" />{m.mod_skip()}
        </Button>
        <Button variant="secondary" class="h-14 flex-col gap-1 text-[11px]" onclick={() => card?.fling('right')} data-testid="triage-keep">
          <Check class="size-4 text-success" />{m.mod_keep()}
        </Button>
      </div>
      <p class="mt-3 text-center text-[11px] text-muted-foreground">{m.mod_hint()} · {m.act_bulk_hint()}</p>
    {/if}
    </div>
    </div>
    {/if}
  {/if}
</section>
