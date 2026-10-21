<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Internal notes button (§6.12): a note icon with the number of notes the
   * admin team left on a post, person or file; opens a sheet to read and add.
   * Admins only — nothing here is ever shown to the public.
   *
   *   <NotesButton subject={{ type: 'event', id: eventId }} />
   */
  import { onMount } from 'svelte';
  import StickyNote from '@lucide/svelte/icons/sticky-note';
  import Sheet from '../Sheet.svelte';
  import Button from '../ui/button.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { runNow } from '$lib/stores/actions.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { ago, cn } from '$lib/utils';
  import { notes, type Note, type NoteSubject } from './notes.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { subject, class: klass = '' }: { subject: NoteSubject; class?: string } = $props();

  let open = $state(false);
  let list = $state<Note[] | null>(null);
  let text = $state('');
  let busy = $state(false);
  const count = $derived(notes.count(subject));
  const canAdd = $derived(app.can('moderation.write') && app.hasAction('notes.add'));

  onMount(() => void notes.ensure());

  async function load() {
    try {
      list = await notes.list(subject);
    } catch {
      list = [];
    }
  }

  function show(e: Event) {
    e.stopPropagation();
    open = true;
    list = null;
    void load();
  }

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    busy = true;
    const r = await runNow('notes.add', { subject: { type: subject.type === 'pubkey' ? 'user' : subject.type, id: subject.id }, text: t }, { afterUndo: load });
    busy = false;
    if (r) {
      text = '';
      await load();
    }
  }
</script>

{#if notes.available}
  <button
    type="button"
    class={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted', count > 0 && 'text-foreground', klass)}
    aria-label={count ? m.act_notes_button_count({ count }) : m.act_notes_button()}
    title={count ? m.act_notes_button_count({ count }) : m.act_notes_button()}
    onclick={show}
    onpointerdown={(e) => e.stopPropagation()}
    data-testid="notes-button"
  >
    <StickyNote class="size-3.5" />{#if count > 0}<span data-testid="notes-count">{count}</span>{/if}
  </button>

  <Sheet bind:open title={m.act_notes_title()} description={m.act_notes_private()} testid="notes-sheet">
    <div class="space-y-3 text-sm">
      {#if list === null}
        <p class="text-muted-foreground">{m.why_loading()}</p>
      {:else if list.length === 0}
        <p class="text-muted-foreground">{m.act_notes_empty()}</p>
      {:else}
        <ul class="space-y-2" data-testid="notes-list">
          {#each list as n (n.id)}
            <li class="rounded-lg bg-muted/60 p-3">
              <p class="whitespace-pre-wrap break-words">{n.text}</p>
              <p class="mt-1 text-xs text-muted-foreground">{n.authorName ?? names.label(n.author)} · {ago(n.at)}</p>
            </li>
          {/each}
        </ul>
      {/if}
      {#if canAdd}
        <form class="space-y-2" onsubmit={add}>
          <textarea
            class="min-h-20 w-full rounded-lg border bg-background p-2 text-sm"
            placeholder={m.act_notes_placeholder()}
            aria-label={m.act_notes_placeholder()}
            maxlength="4000"
            bind:value={text}
            data-testid="notes-input"
          ></textarea>
          <Button type="submit" size="sm" disabled={busy || !text.trim()} data-testid="notes-add">{m.act_notes_add()}</Button>
        </form>
      {/if}
    </div>
  </Sheet>
{/if}
