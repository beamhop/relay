<script lang="ts">
  /** Config time machine (§6.11): a timeline of revisions; restore any point in one tap. */
  import { onMount } from 'svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { app } from '$lib/stores/app.svelte';
  import { announce, asApiError } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { DiffLine, RevisionInfo } from '$lib/api/types';
  import { ago } from '$lib/utils';
  import { to } from '$lib/nav';
  import Sheet from '$lib/components/Sheet.svelte';
  import DiffList from '$lib/components/DiffList.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let items = $state<RevisionInfo[] | null>(null);
  let cursor = $state<string | undefined>();
  let picked = $state<RevisionInfo | null>(null);
  let diff = $state<DiffLine[] | null>(null);
  let open = $state(false);
  let restoring = $state(false);

  async function load(more = false) {
    try {
      const r = await app.api.revisions({ limit: 50, ...(more && cursor ? { cursor } : {}) });
      items = more ? [...(items ?? []), ...r.items] : r.items;
      cursor = r.cursor;
    } catch (err) {
      toasts.error(asApiError(err).message);
      items ??= [];
    }
  }
  onMount(() => load());

  async function pick(r: RevisionInfo) {
    picked = r;
    diff = null;
    open = true;
    try {
      diff = (await app.api.revisionDiff(r.revision)).diff;
    } catch (err) {
      diff = [];
      toasts.error(asApiError(err).message);
    }
  }

  async function restore() {
    if (!picked) return;
    restoring = true;
    try {
      const r = await app.api.restore(picked.revision);
      open = false;
      announce({ summary: m.history_restored({ rev: picked.revision }), ...(r.undo ? { undo: r.undo } : {}) }, () => load());
      await load();
    } catch (err) {
      const e = asApiError(err);
      toasts.error(e.message, e.technical);
    } finally {
      restoring = false;
    }
  }

  const head = $derived(items?.[0]?.revision);

  /** The latest undoable change, still reachable after its toast went away. */
  const lastUndo = $derived(
    toasts.lastUndo && (!toasts.lastUndo.undoExpiresAt || toasts.lastUndo.undoExpiresAt > Date.now() / 1000)
      ? toasts.lastUndo
      : null,
  );

  async function undoLast() {
    if (await toasts.undo(lastUndo?.id)) await load();
  }
  const sourceLabel = (s: RevisionInfo['source']) =>
    ({
      initial: m.history_src_initial(),
      ui: m.history_src_ui(),
      file: m.history_src_file(),
      undo: m.history_src_undo(),
      restore: m.history_src_restore(),
      import: m.history_src_import(),
    })[s] ?? s;
</script>

<svelte:head><title>{m.history_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.history_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.history_desc()}</p>

{#if lastUndo}
  <div class="mt-4 flex items-center gap-3 rounded-xl border bg-card p-3 text-sm" data-testid="history-undo">
    <RotateCcw class="size-4 shrink-0 text-primary" />
    <span class="min-w-0 flex-1">{m.history_undo_last({ what: lastUndo.message })}</span>
    <Button size="sm" variant="secondary" onclick={undoLast} data-testid="history-undo-button">{m.common_undo()}</Button>
  </div>
{/if}

{#if items === null}
  <div class="mt-6 space-y-3">{#each Array(4) as _, i (i)}<Skeleton class="h-14 w-full" />{/each}</div>
{:else}
  <ol class="relative mt-6 ml-2 border-l pl-5" data-testid="timeline">
    {#each items as r (r.revision)}
      <li class="relative pb-5">
        <span class="absolute top-1.5 -left-[26px] size-3 rounded-full border-2 border-background {r.revision === head ? 'bg-primary' : 'bg-muted-foreground/50'}"></span>
        <button class="w-full rounded-lg p-2 text-left hover:bg-muted/50" onclick={() => pick(r)} data-testid={`revision-${r.revision}`}>
          <p class="text-sm">{r.summary || m.history_no_summary()}</p>
          <p class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {r.authorName} · {ago(r.at)}
            <Badge>{sourceLabel(r.source)}</Badge>
            {#if r.revision === head}<Badge tone="accent">{m.history_current()}</Badge>{/if}
            {#if prefs.lens}<span class="font-mono">#{r.revision} · {r.changes} ops</span>{/if}
          </p>
        </button>
      </li>
    {/each}
  </ol>
  {#if cursor}<Button variant="secondary" class="w-full" onclick={() => load(true)}>{m.common_load_more()}</Button>{/if}
{/if}

<Sheet bind:open title={picked ? m.history_restore_title({ when: ago(picked.at) }) : ''} description={m.history_restore_desc()}>
  {#if diff === null}
    <Skeleton class="h-20 w-full" />
  {:else}
    <DiffList {diff} />
  {/if}
  {#snippet footer()}
    <Button class="w-full" disabled={restoring || !picked || picked.revision === head} onclick={restore} data-testid="restore">
      <RotateCcw class="size-4" />{picked?.revision === head ? m.history_current() : m.history_restore()}
    </Button>
  {/snippet}
</Sheet>
