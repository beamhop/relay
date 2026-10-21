<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Bulk bar for a multi-selection in Activity (§6.13): "Keep / Remove / Block
   * authors" → plain preview diff → Apply → undo toast. Removing goes through
   * `moderation.bulk-delete` (one run, two-person rule aware); keep and block
   * go through `POST /actions/{id}/bulk` (one undo for all).
   */
  import Check from '@lucide/svelte/icons/check';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Ban from '@lucide/svelte/icons/ban';
  import X from '@lucide/svelte/icons/x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import type { DiffLine } from '$lib/api/types';
  import { app } from '$lib/stores/app.svelte';
  import { announce, asApiError } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { haptic } from '$lib/haptics';
  import Sheet from '../Sheet.svelte';
  import DiffList from '../DiffList.svelte';
  import Button from '../ui/button.svelte';
  import { type BulkKind, type BulkPlan, type Pick, isApprovalPending, planBulk } from './bulk';
  import { m } from '$lib/paraglide/messages.js';

  let {
    picks,
    kinds = ['keep', 'remove', 'ban'],
    oncancel,
    ondone,
  }: {
    picks: Pick[];
    kinds?: BulkKind[];
    oncancel: () => void;
    /** After a run (`pending` = waiting for a second admin) and after an undo. */
    ondone?: (kind: BulkKind, pending: boolean) => void;
  } = $props();

  let open = $state(false);
  let plan = $state<BulkPlan | null>(null);
  let diff = $state<DiffLine[] | null>(null);
  let error = $state<string | null>(null);
  let running = $state(false);

  const can = $derived(app.can('moderation.write'));
  const available = $derived(
    kinds.filter((k) =>
      app.hasAction(k === 'keep' ? 'moderation.keep' : k === 'ban' ? 'moderation.ban-pubkey' : 'moderation.bulk-delete'),
    ),
  );
  const label = (k: BulkKind) => (k === 'keep' ? m.act_bulk_keep() : k === 'remove' ? m.act_bulk_remove() : m.act_bulk_ban());

  async function start(kind: BulkKind) {
    const p = planBulk(kind, picks);
    plan = p;
    diff = null;
    error = null;
    open = true;
    if (p.count === 0) return;
    try {
      const scope = app.action(p.actionId)?.scope ?? 'relay';
      diff = (await app.api.preview(p.actionId, p.previewInput, scope)).diff;
    } catch (err) {
      error = asApiError(err).message;
    }
  }

  async function apply() {
    const p = plan;
    if (!p || p.count === 0) return;
    running = true;
    error = null;
    const scope = app.action(p.actionId)?.scope ?? 'relay';
    try {
      if (p.inputs) {
        const r = await app.api.bulk(p.actionId, p.inputs, scope);
        const failed = r.results.filter((x) => !x.ok).length;
        announce(r, () => ondone?.(p.kind, false));
        if (failed) toasts.error(m.act_bulk_failed({ count: failed }), r.results.find((x) => !x.ok)?.error?.message);
        ondone?.(p.kind, false);
      } else {
        const r = await app.api.run(p.actionId, p.previewInput, scope);
        if (isApprovalPending(r.output)) {
          haptic('success');
          toasts.show({ message: m.act_bulk_pending(), kind: 'info' });
          ondone?.(p.kind, true);
        } else {
          announce(r, () => ondone?.(p.kind, false));
          ondone?.(p.kind, false);
        }
      }
      open = false;
    } catch (err) {
      const e = asApiError(err);
      error = e.message;
      haptic('warning');
    } finally {
      running = false;
    }
  }
</script>

<div
  class="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-sm"
  role="toolbar"
  aria-label={m.act_bulk_toolbar()}
  data-testid="bulk-bar"
>
  <span class="px-1 text-sm font-medium" data-testid="bulk-count">{m.act_bulk_selected({ count: picks.length })}</span>
  <span class="flex-1"></span>
  {#if can}
    {#each available as k (k)}
      <Button size="sm" variant="secondary" disabled={picks.length === 0} onclick={() => start(k)} data-testid={`bulk-${k}`}>
        {#if k === 'keep'}<Check class="size-3.5 text-success" />{:else if k === 'remove'}<Trash2 class="size-3.5 text-destructive" />{:else}<Ban class="size-3.5 text-destructive" />{/if}
        {label(k)}
      </Button>
    {/each}
  {/if}
  <Button size="sm" variant="ghost" onclick={oncancel} aria-label={m.common_cancel()} data-testid="bulk-cancel"><X class="size-4" /></Button>
</div>

<Sheet bind:open title={plan ? label(plan.kind) : ''} testid="bulk-sheet">
  {#if plan}
    <div class="space-y-3 text-sm">
      {#if prefs.lens}
        <p class="rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground" data-lens>
          {plan.actionId}{plan.inputs ? ` · bulk × ${plan.inputs.length}` : ''}
        </p>
      {/if}
      {#if plan.count === 0}
        <p class="text-muted-foreground" data-testid="bulk-nothing">{m.act_bulk_nothing()}</p>
      {:else if diff === null && !error}
        <p class="flex items-center gap-2 text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />{m.why_loading()}</p>
      {:else if diff}
        <DiffList {diff} />
      {/if}
      {#if plan.skipped > 0}
        <p class="text-xs text-muted-foreground" data-testid="bulk-skipped">{m.act_bulk_skipped({ count: plan.skipped })}</p>
      {/if}
      {#if error}<p class="text-destructive" role="alert">{error}</p>{/if}
    </div>
  {/if}
  {#snippet footer()}
    <div class="flex gap-2">
      <Button variant="secondary" class="flex-1" onclick={() => (open = false)}>{m.common_cancel()}</Button>
      <Button
        class="flex-1"
        variant={plan?.kind === 'keep' ? 'default' : 'destructive'}
        disabled={running || !plan || plan.count === 0 || !diff}
        onclick={apply}
        data-testid="bulk-apply"
      >
        {#if running}<LoaderCircle class="size-4 animate-spin" />{/if}{m.act_bulk_apply()}
      </Button>
    </div>
  {/snippet}
</Sheet>
