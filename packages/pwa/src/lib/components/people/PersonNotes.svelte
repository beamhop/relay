<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Internal team notes on a person (§6.12): `notes.list` / `notes.add` with
   * subject `{ type: 'user', id: pubkey }`. Only the admin team sees them.
   */
  import { app } from '$lib/stores/app.svelte';
  import { query, runNow } from '$lib/stores/actions.svelte';
  import { ago } from '$lib/utils';
  import Button from '../ui/button.svelte';
  import ItemLens from '../ItemLens.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { pubkey }: { pubkey: string } = $props();

  interface Note {
    id: string;
    text: string;
    author?: string;
    authorName: string;
    at: number;
  }

  let notes = $state<Note[]>([]);
  let draft = $state('');
  let saving = $state(false);

  $effect(() => {
    void load(pubkey);
  });

  async function load(pk: string) {
    const r = await query<{ notes: Note[] }>('notes.list', { subject: { type: 'user', id: pk } });
    if (pk === pubkey) notes = r?.notes ?? [];
  }

  async function add() {
    const text = draft.trim();
    if (!text) return;
    saving = true;
    const pk = pubkey;
    const r = await runNow('notes.add', { subject: { type: 'user', id: pk }, text }, { afterUndo: () => load(pk) });
    saving = false;
    if (r) {
      draft = '';
      await load(pk);
    }
  }
</script>

<section aria-labelledby="notes-title" data-testid="person-notes">
  <h3 id="notes-title" class="mb-2 text-sm font-medium">{m.notes_title()}</h3>
  <p class="mb-2 text-xs text-muted-foreground">{m.notes_private()}</p>
  <ul class="space-y-2" data-testid="notes">
    {#each notes as n (n.id)}
      <li class="rounded-lg bg-muted/50 p-3 text-sm" data-testid="note">
        <p class="whitespace-pre-wrap">{n.text}</p>
        <p class="mt-1 text-xs text-muted-foreground">{n.authorName} · {ago(n.at)}</p>
        <ItemLens lines={[`note ${n.id}`, ...(n.author ? [`author ${n.author}`] : [])]} />
      </li>
    {:else}
      <li class="text-xs text-muted-foreground">{m.notes_empty()}</li>
    {/each}
  </ul>
  {#if app.hasAction('notes.add') && app.can('moderation.write')}
    <form
      class="mt-3 flex gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <input
        class="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
        placeholder={m.notes_placeholder()}
        aria-label={m.notes_placeholder()}
        maxlength={4000}
        bind:value={draft}
        data-testid="note-input"
      />
      <Button type="submit" disabled={saving || !draft.trim()} data-testid="note-add">{m.notes_add()}</Button>
    </form>
  {/if}
</section>
