<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail bottom sheet: plan, storage, quick actions and internal team notes (§6.12). */
  import { app } from '$lib/stores/app.svelte';
  import { flow, query, runNow } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { ago, formatBytes } from '$lib/utils';
  import { names } from '$lib/stores/names.svelte';
  import Sheet from '../Sheet.svelte';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import { quotaOf, type UserRow } from './users';
  import QuotaBar from './QuotaBar.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { user = $bindable(null), onchange }: { user: UserRow | null; onchange?: () => void } = $props();

  interface Note {
    id: string;
    text: string;
    authorName: string;
    at: number;
  }

  let open = $state(false);
  let notes = $state<Note[]>([]);
  let draft = $state('');
  let saving = $state(false);

  $effect(() => {
    open = !!user;
    if (user) void loadNotes(user.pubkey);
  });

  async function loadNotes(pubkey: string) {
    const r = await query<{ notes: Note[] }>('notes.list', { subject: { type: 'user', id: pubkey } });
    notes = r?.notes ?? [];
  }

  async function addNote() {
    if (!user || !draft.trim()) return;
    saving = true;
    const pk = user.pubkey;
    const r = await runNow('notes.add', { subject: { type: 'user', id: pk }, text: draft.trim() }, { afterUndo: () => loadNotes(pk) });
    saving = false;
    if (r) {
      draft = '';
      await loadNotes(pk);
    }
  }

  function start(id: string, input: Record<string, unknown>, form = false) {
    const def = app.action(id);
    if (!def) return;
    void flow.start(def, input, { form, onDone: () => onchange?.(), onUndo: () => onchange?.() });
  }
</script>

<Sheet bind:open title={user?.name ?? names.label(user?.pubkey)} onclose={() => (user = null)} testid="user-sheet">
  {#if user}
    <div class="space-y-5">
      <div class="flex flex-wrap gap-2">
        {#if user.banned}<Badge tone="critical">{m.people_banned()}</Badge>{/if}
        {#if user.muted}<Badge tone="warn">{m.people_muted()}</Badge>{/if}
        {#if user.tier}<Badge tone="accent">{user.tier}</Badge>{/if}
        {#if user.admin}<Badge>{m.people_team_member()}</Badge>{/if}
      </div>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <div class="rounded-lg bg-muted/50 p-3">
          <dt class="text-xs text-muted-foreground">{m.people_storage()}</dt>
          <dd class="font-medium">{formatBytes(user.usedBytes ?? user.storageBytes ?? 0)}</dd>
        </div>
        <div class="rounded-lg bg-muted/50 p-3">
          <dt class="text-xs text-muted-foreground">{m.people_last_seen()}</dt>
          <dd class="font-medium">{user.lastSeen ? ago(user.lastSeen) : '—'}</dd>
        </div>
      </dl>
      {#if quotaOf(user)}
        {@const q = quotaOf(user)!}
        <div class="rounded-lg bg-muted/50 p-3" data-testid="user-quota">
          <p class="text-xs text-muted-foreground">{m.quota_title()}</p>
          <QuotaBar {q} />
        </div>
      {/if}
      {#if prefs.lens}<p class="break-all font-mono text-[11px] text-muted-foreground" data-lens>{user.pubkey}</p>{/if}

      <div class="grid grid-cols-2 gap-2">
        {#if app.hasAction('users.set-tier')}
          <Button variant="secondary" size="sm" onclick={() => start('users.set-tier', { pubkey: user!.pubkey, tier: null }, true)}>{m.people_set_tier()}</Button>
        {/if}
        {#if app.hasAction('media.set-quota')}
          <Button variant="secondary" size="sm" onclick={() => start('media.set-quota', { pubkey: user!.pubkey, quotaBytes: null }, true)}>{m.people_set_quota()}</Button>
        {/if}
        {#if user.muted}
          <Button variant="secondary" size="sm" onclick={() => start('moderation.unmute-pubkey', { pubkeys: [user!.pubkey] })}>{m.people_unmute()}</Button>
        {:else}
          <Button variant="secondary" size="sm" onclick={() => start('moderation.mute-pubkey', { pubkeys: [user!.pubkey] }, true)}>{m.people_mute()}</Button>
        {/if}
        {#if user.banned}
          <Button variant="secondary" size="sm" onclick={() => start('moderation.unban-pubkey', { pubkeys: [user!.pubkey] })}>{m.people_unban()}</Button>
        {:else}
          <Button variant="destructive" size="sm" onclick={() => start('moderation.ban-pubkey', { pubkeys: [user!.pubkey] })}>{m.people_ban()}</Button>
        {/if}
      </div>

      <section aria-labelledby="notes-title">
        <h3 id="notes-title" class="mb-2 text-sm font-medium">{m.notes_title()}</h3>
        <p class="mb-2 text-xs text-muted-foreground">{m.notes_private()}</p>
        <ul class="space-y-2" data-testid="notes">
          {#each notes as n (n.id)}
            <li class="rounded-lg bg-muted/50 p-3 text-sm">
              <p class="whitespace-pre-wrap">{n.text}</p>
              <p class="mt-1 text-xs text-muted-foreground">{n.authorName} · {ago(n.at)}</p>
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
              void addNote();
            }}
          >
            <input class="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm" placeholder={m.notes_placeholder()} aria-label={m.notes_placeholder()} bind:value={draft} />
            <Button type="submit" disabled={saving || !draft.trim()}>{m.notes_add()}</Button>
          </form>
        {/if}
      </section>
    </div>
  {/if}
</Sheet>
