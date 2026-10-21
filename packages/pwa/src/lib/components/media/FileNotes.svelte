<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Internal team notes on one file (`notes.list` / `notes.add`, subject `{ type: 'blob', id: sha256 }`). */
  import Button from '$lib/components/ui/button.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { query, runNow } from '$lib/stores/actions.svelte';
  import { ago } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  interface Note {
    id: string;
    text: string;
    author: string;
    authorName?: string;
    at: number;
  }

  let { sha256 }: { sha256: string } = $props();
  let notes = $state<Note[]>([]);
  let text = $state('');
  let busy = $state(false);

  const subject = $derived({ type: 'blob', id: sha256 });

  async function load() {
    const r = await query<{ notes: Note[] }>('notes.list', { subject, limit: 100 });
    notes = r?.notes ?? [];
  }

  $effect(() => {
    void sha256;
    void load();
  });

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    busy = true;
    const r = await runNow('notes.add', { subject, text: t }, { afterUndo: () => void load() });
    busy = false;
    if (r) {
      text = '';
      await load();
    }
  }
</script>

{#if app.hasAction('notes.list')}
  <section data-testid="file-notes">
    <h3 class="mb-2 text-sm font-medium">{m.media_notes_title()}</h3>
    {#if notes.length}
      <ul class="mb-2 space-y-2">
        {#each notes as n (n.id)}
          <li class="rounded-lg bg-muted px-3 py-2 text-sm" data-testid="file-note">
            <p class="whitespace-pre-wrap">{n.text}</p>
            <p class="mt-1 text-[11px] text-muted-foreground">{m.media_notes_by({ name: n.authorName ?? n.author, when: ago(n.at) })}</p>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mb-2 text-xs text-muted-foreground">{m.media_notes_empty()}</p>
    {/if}
    {#if app.hasAction('notes.add') && app.can('moderation.write')}
      <form class="flex gap-2" onsubmit={add}>
        <input
          class="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={m.media_notes_placeholder()}
          aria-label={m.media_notes_placeholder()}
          maxlength="4000"
          bind:value={text}
          data-testid="file-note-input"
        />
        <Button type="submit" size="sm" disabled={!text.trim() || busy} data-testid="file-note-add">{m.media_notes_add()}</Button>
      </form>
    {/if}
  </section>
{/if}
