<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Inbox-zero attention cards (§6.8, §6.9): swipe right runs the card's
   * primary action (preview → confirm → undo toast); swipe left snoozes it.
   * Dismiss hides a card for good (it returns only when something new joins
   * it); keyboard `e`. Nothing is ever applied without explicit approval.
   */
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import type { Direction } from '$lib/gestures/recognizer';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { assistant } from '$lib/stores/assistant.svelte';
  import { DISMISS, DISMISS_SECONDS, SNOOZE, type HomeCard, snoozeLocal, unsnoozeLocal } from '$lib/cards';
  import { to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import SwipeCard from '../SwipeCard.svelte';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { cards, onchange }: { cards: HomeCard[]; onchange: () => void } = $props();

  let card: SwipeCard | undefined = $state();
  const top = $derived(cards[0]);
  const canApprove = $derived(!!top?.approve);

  function approve(c: HomeCard) {
    if (!c.approve) return;
    const def = app.action(c.approve.actionId);
    if (!def) return;
    void flow.start(def, c.approve.input, { onDone: () => onchange(), onUndo: () => onchange() });
  }

  async function dismiss(c: HomeCard) {
    if (c.source === 'inbox' && app.hasAction(SNOOZE)) {
      try {
        const r = await app.api.run(SNOOZE, { key: c.key, hours: 24 }, 'node');
        onchange();
        const token = r.undo?.token;
        toasts.show(
          {
            message: m.cards_snoozed(),
            kind: 'info',
            ...(token
              ? {
                  undo: async () => {
                    await app.api.undo(token);
                    onchange();
                  },
                }
              : {}),
          },
          6000,
        );
      } catch (err) {
        toasts.error(asApiError(err).message);
      }
      return;
    }
    snoozeLocal(c.key);
    onchange();
    toasts.show(
      {
        message: m.cards_snoozed(),
        kind: 'info',
        undo: async () => {
          unsnoozeLocal(c.key);
          onchange();
        },
      },
      6000,
    );
  }

  /** Hide the card for good (server-side per admin; this device only without the experience module). */
  async function dismissForGood(c: HomeCard) {
    if (c.source === 'inbox' && app.hasAction(DISMISS)) {
      try {
        const r = await app.api.run(DISMISS, { key: c.key }, 'node');
        onchange();
        const token = r.undo?.token;
        toasts.show(
          {
            message: m.cards_dismissed(),
            kind: 'info',
            ...(token
              ? {
                  undo: async () => {
                    await app.api.undo(token);
                    onchange();
                  },
                }
              : {}),
          },
          6000,
        );
      } catch (err) {
        toasts.error(asApiError(err).message);
      }
      return;
    }
    snoozeLocal(c.key, DISMISS_SECONDS);
    onchange();
    toasts.show(
      {
        message: m.cards_dismissed(),
        kind: 'info',
        undo: async () => {
          unsnoozeLocal(c.key);
          onchange();
        },
      },
      6000,
    );
  }

  // The assistant gets the card on screen as context.
  $effect(() => {
    assistant.setSelection(top ? { card: top.key, title: top.title } : undefined);
    return () => assistant.setSelection(undefined);
  });

  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!top || e.key !== 'e' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('[role="dialog"]')) return;
    e.preventDefault();
    void dismissForGood(top);
  }

  function onswipe(d: Direction) {
    if (!top) return;
    if (d === 'right') approve(top);
    else void dismiss(top);
  }

  const icons = { info: Info, warning: TriangleAlert, critical: CircleAlert };
  const tones = { info: 'accent', warning: 'warn', critical: 'critical' } as const;
</script>

<svelte:window {onkeydown} />

<section aria-labelledby="attention-title" data-testid="attention">
  <div class="mb-2 flex items-baseline justify-between">
    <h2 id="attention-title" class="text-sm font-medium">{m.home_attention()}</h2>
    {#if cards.length > 1}<span class="text-xs text-muted-foreground">{m.home_attention_more({ count: cards.length - 1 })}</span>{/if}
  </div>

  {#if !top}
    <div class="flex items-center gap-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground" data-testid="inbox-zero">
      <CircleCheck class="size-5 text-success" />
      {m.home_inbox_zero()}
    </div>
  {:else}
    <div class="relative">
      {#if cards[1]}
        <div class="absolute inset-x-3 -bottom-2 h-full rounded-xl border bg-card/60" aria-hidden="true"></div>
      {/if}
      {#key top.key}
        <SwipeCard
          bind:this={card}
          directions={canApprove ? ['left', 'right'] : ['left']}
          hints={canApprove
            ? { right: { label: top.primaryLabel ?? m.cards_approve(), tone: 'ok' }, left: { label: m.cards_snooze(), tone: 'neutral' } }
            : { left: { label: m.cards_snooze(), tone: 'neutral' } }}
          {onswipe}
          testid="attention-card"
        >
          {@const Icon = icons[top.severity]}
          <article
            class={cn(
              'rounded-xl border bg-card p-4 shadow-sm',
              top.severity === 'info' && 'border-primary/30 bg-primary/5',
              top.severity === 'warning' && 'border-warning/40',
              top.severity === 'critical' && 'border-destructive/50',
            )}
            data-severity={top.severity}
            data-approvable={canApprove}
          >
            <div class="flex items-start gap-3">
              <Icon class="mt-0.5 size-5 shrink-0 {top.severity === 'critical' ? 'text-destructive' : top.severity === 'warning' ? 'text-warning' : 'text-primary'}" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h3 class="font-medium leading-snug">{names.text(top.title)}</h3>
                  {#if top.count > 1}<Badge tone={tones[top.severity]}>×{top.count}</Badge>{/if}
                </div>
                <p class="mt-1 text-sm text-muted-foreground">{names.text(top.body)}</p>
                {#if prefs.lens && top.technical}<p class="mt-2 font-mono text-[11px] text-muted-foreground" data-lens>{top.technical}</p>{/if}
              </div>
            </div>
            <div class="mt-4 flex flex-wrap items-center gap-2">
              {#if canApprove}
                <Button size="sm" onclick={() => approve(top)} data-testid="card-primary">{top.primaryLabel ?? m.cards_approve()}</Button>
              {/if}
              <Button size="sm" variant="secondary" onclick={() => card?.fling('left')} data-testid="card-snooze">{m.cards_snooze()}</Button>
              <Button size="sm" variant="ghost" onclick={() => dismissForGood(top)} data-testid="card-dismiss">{m.cards_dismiss()}</Button>
              {#if top.playbook}
                <Button size="sm" variant="ghost" href={to(`/help?playbook=${top.playbook}`)}>{m.cards_guide()}</Button>
              {/if}
              <span class="ml-auto hidden text-[11px] text-muted-foreground sm:inline" data-testid="card-swipe-hint">
                {canApprove ? m.cards_swipe_hint() : m.cards_swipe_hint_later()}
              </span>
            </div>
          </article>
        </SwipeCard>
      {/key}
    </div>
  {/if}
</section>
