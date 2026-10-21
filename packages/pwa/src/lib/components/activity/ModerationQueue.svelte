<script lang="ts">
  /**
   * Swipe triage (§5.3, §6.2): → keep, ← remove, ↑ block author, ↓ skip.
   * Every decision runs at once and shows an undo toast. Keyboard:
   * e keep · x remove · # block · j / s skip · k back · u undo.
   */
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Ban from '@lucide/svelte/icons/ban';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import Flag from '@lucide/svelte/icons/flag';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import type { QueueItem, RunResult } from '$lib/api/types';
  import type { Direction } from '$lib/gestures/recognizer';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { haptic } from '$lib/haptics';
  import { short, ago } from '$lib/utils';
  import SwipeCard from '../SwipeCard.svelte';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import Skeleton from '../ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let items = $state<QueueItem[] | null>(null);
  let skipped = $state<QueueItem[]>([]);
  let error = $state<string | null>(null);
  let card: SwipeCard | undefined = $state();
  let busy = $state(false);

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
    if (!top || !canModerate) return;
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
    <p class="mb-3 text-xs text-muted-foreground" data-testid="queue-count">{m.mod_remaining({ count: items.length })}</p>
    <div class="relative mx-auto max-w-lg">
      {#if items[1]}<div class="absolute inset-x-4 -bottom-2 h-full rounded-2xl border bg-card/50" aria-hidden="true"></div>{/if}
      {#key top.id}
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
          <article class="min-h-56 rounded-2xl border bg-card p-5 shadow-sm">
            <div class="flex items-center gap-2">
              <Badge tone={top.type === 'report' ? 'warn' : 'neutral'}>{typeLabel(top)}</Badge>
              <span class="text-xs text-muted-foreground">{ago(top.createdAt)}</span>
            </div>
            <p class="mt-3 flex items-start gap-2 text-sm font-medium" data-testid="queue-reason">
              <Flag class="mt-0.5 size-4 shrink-0 text-warning" />{top.reason}
            </p>
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
              {m.mod_author()} <span class="font-mono">{short(top.pubkey ?? top.event?.pubkey)}</span>
            </p>
            {#if prefs.lens}
              <p class="mt-2 break-all font-mono text-[11px] text-muted-foreground" data-lens>
                {top.technical ?? ''} {top.event ? `kind ${top.event.kind} · ${top.event.id}` : ''} {top.sha256 ?? ''}
              </p>
            {/if}
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
      <p class="mt-3 text-center text-[11px] text-muted-foreground">{m.mod_hint()}</p>
    {/if}
  {/if}
</section>
