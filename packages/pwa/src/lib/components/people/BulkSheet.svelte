<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Bulk action on several people (§6.13): plain combined diff first, then
   * one apply and one undo toast that reverts everyone.
   */
  import { untrack } from 'svelte';
  import type { DiffLine } from '$lib/api/types';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { haptic } from '$lib/haptics';
  import Sheet from '../Sheet.svelte';
  import DiffList from '../DiffList.svelte';
  import ItemLens from '../ItemLens.svelte';
  import Button from '../ui/button.svelte';
  import { BULK, inputsFor, mergeDiffs, runBulk, undoAll, type BulkKind } from './bulk';
  import { m } from '$lib/paraglide/messages.js';

  let {
    kind = $bindable(null),
    pubkeys,
    tiers = [],
    onapplied,
    onundone,
  }: {
    kind: BulkKind | null;
    pubkeys: string[];
    tiers?: Array<{ id: string; name: string }>;
    onapplied?: () => void;
    onundone?: () => void;
  } = $props();

  /** How many per-person previews to ask for (the rest are summarized). */
  const PREVIEW_CAP = 25;

  let open = $state(false);
  let tier = $state<string | null | undefined>(undefined);
  let diff = $state<DiffLine[] | null>(null);
  let more = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const def = $derived(kind ? BULK[kind] : null);
  const action = $derived(def ? app.action(def.actionId) : undefined);
  const count = $derived(pubkeys.length);
  const title = $derived(
    kind === 'ban'
      ? m.ppl_bulk_title_ban({ count })
      : kind === 'mute'
        ? m.ppl_bulk_title_mute({ count })
        : kind === 'tier'
          ? m.ppl_bulk_title_tier({ count })
          : m.ppl_bulk_title_unallow({ count }),
  );
  const needsTier = $derived(kind === 'tier' && tier === undefined);

  $effect(() => {
    const k = kind;
    open = !!k;
    if (k)
      untrack(() => {
        tier = undefined;
        diff = null;
        error = null;
        if (k !== 'tier') void preview();
      });
  });

  async function preview() {
    if (!def || !action) return;
    diff = null;
    more = 0;
    error = null;
    try {
      if (def.all) {
        diff = (await app.api.preview(def.actionId, def.all(pubkeys), action.scope)).diff;
      } else {
        const inputs = inputsFor(def, pubkeys.slice(0, PREVIEW_CAP), { tier: tier ?? null });
        const lists = await Promise.all(inputs.map((i) => app.api.preview(def.actionId, i, action.scope).then((r) => r.diff)));
        const merged = mergeDiffs(lists);
        diff = merged.lines;
        more = merged.more + Math.max(0, count - PREVIEW_CAP);
      }
    } catch (err) {
      error = asApiError(err).message;
      diff = [];
    }
  }

  function pickTier(id: string | null) {
    tier = id;
    void preview();
  }

  async function apply() {
    if (!def || !action) return;
    busy = true;
    error = null;
    const label = action.title;
    try {
      const out = await runBulk(app.api, def.actionId, inputsFor(def, pubkeys, { tier: tier ?? null }), {
        bulk: action.bulk,
        scope: action.scope,
      });
      haptic(out.failed.length ? 'warning' : 'success');
      const message = m.ppl_bulk_done({ what: label, count: out.done });
      const tokens = out.undoTokens;
      if (tokens.length)
        toasts.success(
          message,
          async () => {
            try {
              await undoAll((t) => app.api.undo(t), tokens);
              toasts.show({ message: m.ppl_bulk_undone(), kind: 'info' });
            } catch (err) {
              const e = asApiError(err);
              toasts.error(e.message, e.technical);
            }
            onundone?.();
          },
          out.undoExpiresAt,
        );
      else toasts.success(message);
      if (out.failed.length) toasts.error(m.ppl_bulk_failed({ count: out.failed.length }), out.failed.map((f) => f.message).join('\n'));
      kind = null;
      onapplied?.();
    } catch (err) {
      const e = asApiError(err);
      error = e.message;
      haptic('warning');
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open {title} onclose={() => (kind = null)} testid="bulk-sheet">
  {#if needsTier}
    <p class="mb-2 text-sm font-medium">{m.ppl_bulk_pick_tier()}</p>
    <div class="grid gap-2" data-testid="bulk-tiers">
      {#each tiers as t (t.id)}
        <Button variant="secondary" class="justify-start" onclick={() => pickTier(t.id)} data-tier={t.id}>{t.name}</Button>
      {/each}
      <Button variant="ghost" class="justify-start" onclick={() => pickTier(null)} data-tier="">{m.ppl_bulk_auto_tier()}</Button>
    </div>
  {:else if diff === null}
    <p class="text-sm text-muted-foreground">{m.ppl_bulk_loading()}</p>
  {:else}
    <DiffList {diff} />
    {#if more}<p class="mt-2 text-xs text-muted-foreground">{m.ppl_bulk_more({ count: more })}</p>{/if}
    <div class="mt-2">
      <ItemLens lines={[`POST /actions/${def?.actionId}/bulk${action?.bulk ? '' : ' (one by one)'}`, `${count} inputs`]} />
    </div>
  {/if}
  {#if error}<p class="mt-3 text-sm text-destructive" role="alert">{error}</p>{/if}

  {#snippet footer()}
    {#if !needsTier}
      <div class="flex gap-2">
        <Button variant="ghost" class="flex-1" onclick={() => (kind = null)}>{m.common_cancel()}</Button>
        <Button
          variant={kind === 'ban' || kind === 'unallow' ? 'destructive' : 'default'}
          class="flex-1"
          disabled={busy || diff === null}
          onclick={apply}
          data-testid="bulk-apply">{m.ppl_bulk_apply({ count })}</Button
        >
      </div>
    {/if}
  {/snippet}
</Sheet>
