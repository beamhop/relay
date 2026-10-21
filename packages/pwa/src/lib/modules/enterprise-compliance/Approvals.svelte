<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Approvals inbox (two-person rule, §12.9): a swipe stack of risky changes
   * other admins asked for — swipe right / `e` approves, swipe left / `x`
   * denies. Each card says who asked, why, and what will happen (the asked
   * action's own preview). Your own requests are listed apart: you cannot
   * approve them, only withdraw them or carry them out once approved.
   */
  import { onMount } from 'svelte';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import type { DiffLine } from '$lib/api/types';
  import type { Direction } from '$lib/gestures/recognizer';
  import { app } from '$lib/stores/app.svelte';
  import { query, runNow } from '$lib/stores/actions.svelte';
  import { names } from '$lib/stores/names.svelte';
  import SwipeCard from '$lib/components/SwipeCard.svelte';
  import DiffList from '$lib/components/DiffList.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import Waiting from '../shared/Waiting.svelte';
  import { requests } from '../shared/requests.svelte.ts';
  import { type ApprovalRow, ago, timeLeft, withoutGateLine } from '../shared/approvals.ts';
  import { decidedText, requesterName, stackOrder } from './approvals-view.ts';

  let { focus = '' }: { focus?: string } = $props();

  let rows = $state<ApprovalRow[] | null>(null);
  let busy = $state(false);
  let card: SwipeCard | undefined = $state();
  const previews = $state<Record<string, DiffLine[] | 'none'>>({});

  async function load() {
    const r = await query<{ requests: ApprovalRow[] }>('approvals.list', { limit: 200 });
    rows = r?.requests ?? [];
    names.rememberRows(rows.map((x) => ({ pubkey: x.requestedByPubkey, name: x.requestedByName })));
    requests.rows = rows;
  }
  onMount(load);

  const stack = $derived(stackOrder(rows ?? [], focus));
  const top = $derived(stack[0]);
  const mine = $derived((rows ?? []).filter((r) => r.mine && (r.status === 'pending' || r.status === 'approved')));
  const decided = $derived(
    (rows ?? []).filter((r) => r.status !== 'pending' && !(r.mine && r.status === 'approved')).slice(0, 10),
  );

  /** What the asked change will do: the action's own preview, without the gate's line. */
  $effect(() => {
    const r = top;
    if (!r || previews[r.id]) return;
    const def = app.action(r.actionId);
    if (!def) {
      previews[r.id] = 'none';
      return;
    }
    const input = r.input && typeof r.input === 'object' ? r.input : {};
    app.api
      .preview(r.actionId, input, def.scope)
      .then((p) => (previews[r.id] = withoutGateLine(p.diff)))
      .catch(() => (previews[r.id] = 'none'));
  });

  async function decide(r: ApprovalRow, approve: boolean) {
    if (busy) return;
    busy = true;
    try {
      await runNow(approve ? 'approvals.approve' : 'approvals.deny', { requestId: r.id });
    } finally {
      busy = false;
      await load();
    }
  }

  function onswipe(d: Direction) {
    if (top) void decide(top, d === 'right');
  }

  function onkeydown(e: KeyboardEvent) {
    if (!top || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'e' && e.key !== 'x') return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('[role="dialog"]')) return;
    e.preventDefault();
    card?.fling(e.key === 'e' ? 'right' : 'left');
  }

  const preview = $derived(top ? previews[top.id] : undefined);
</script>

<svelte:window {onkeydown} />

<div class="space-y-6 md:max-w-2xl" data-testid="approvals">
  {#if !app.hasAction('approvals.list')}
    <p class="text-sm text-muted-foreground">Approvals by a second admin are turned off.</p>
  {:else if rows === null}
    <Skeleton class="h-48 w-full" />
  {:else}
    <section aria-labelledby="approvals-title">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 id="approvals-title" class="text-sm font-medium">Waiting for your decision</h2>
        {#if stack.length > 1}<span class="text-xs text-muted-foreground">{stack.length - 1} more</span>{/if}
      </div>
      {#if !top}
        <div class="flex items-center gap-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground" data-testid="approvals-empty">
          <CircleCheck class="size-5 text-success" />Nothing to approve.
        </div>
      {:else}
        <div class="relative">
          {#if stack[1]}<div class="absolute inset-x-3 -bottom-2 h-full rounded-xl border bg-card/60" aria-hidden="true"></div>{/if}
          {#key top.id}
            <SwipeCard
              bind:this={card}
              directions={['left', 'right']}
              hints={{ right: { label: 'Approve', tone: 'ok' }, left: { label: 'Deny', tone: 'critical' } }}
              {onswipe}
              disabled={busy}
              testid="approval-card"
            >
              <article class="rounded-xl border border-warning/40 bg-card p-4 shadow-sm" data-request={top.id}>
                <div class="flex items-start gap-3">
                  <ShieldCheck class="mt-0.5 size-5 shrink-0 text-warning" />
                  <div class="min-w-0 flex-1">
                    <h3 class="font-medium leading-snug">{top.actionTitle}</h3>
                    <p class="mt-1 text-sm text-muted-foreground" data-testid="approval-requester">
                      {requesterName(top, names)} asked {ago(top.createdAt)}{top.reason ? ` — “${top.reason}”` : ''}
                    </p>
                  </div>
                  <Badge tone="warn">Ends {timeLeft(top.expiresAt)}</Badge>
                </div>
                <div class="mt-3" data-testid="approval-diff">
                  <p class="mb-1.5 text-xs font-medium text-muted-foreground">If you approve:</p>
                  {#if preview === undefined}
                    <Skeleton class="h-10 w-full" />
                  {:else if preview === 'none' || preview.length === 0}
                    <p class="text-sm">{requesterName(top, names)} will be able to {top.actionTitle.charAt(0).toLowerCase()}{top.actionTitle.slice(1)}.</p>
                  {:else}
                    <DiffList diff={preview} />
                  {/if}
                </div>
                <div class="mt-2">
                  <ItemLens lines={[`${top.actionId} · request ${top.id}`, `input ${JSON.stringify(top.input)}`, 'two-person rule (§12.9): approver ≠ requester, single-use']} />
                </div>
                <div class="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" onclick={() => card?.fling('right')} disabled={busy} data-testid="approve">Approve</Button>
                  <Button size="sm" variant="secondary" onclick={() => card?.fling('left')} disabled={busy} data-testid="deny">Deny</Button>
                  <span class="ml-auto hidden text-[11px] text-muted-foreground sm:inline">Swipe right or press e to approve, left or x to deny</span>
                </div>
              </article>
            </SwipeCard>
          {/key}
        </div>
      {/if}
    </section>

    {#if mine.length}
      <section data-testid="my-requests">
        <h2 class="mb-2 text-sm font-medium">You asked for</h2>
        <ul class="space-y-2">
          {#each mine as r (r.id)}
            <li class="rounded-xl border p-3">
              <p class="text-sm font-medium">{r.actionTitle}</p>
              <div class="mt-2"><Waiting row={r} after={load} /></div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if decided.length}
      <section data-testid="decided">
        <h2 class="mb-2 text-sm font-medium">Recently decided</h2>
        <ul class="divide-y rounded-xl border">
          {#each decided as r (r.id)}
            <li class="p-3 text-sm">
              <p>{r.actionTitle}</p>
              <p class="text-xs text-muted-foreground">{decidedText(r, names)}</p>
              <ItemLens lines={[`${r.actionId} · request ${r.id} · ${r.status}`]} />
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>
