<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail bottom sheet: plan, storage, quick actions, "Why?" for blocks and internal team notes (§6.12). */
  import { app } from '$lib/stores/app.svelte';
  import { flow } from '$lib/stores/actions.svelte';
  import { ago, formatBytes } from '$lib/utils';
  import { names } from '$lib/stores/names.svelte';
  import Sheet from '../Sheet.svelte';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import WhyButton from '../WhyButton.svelte';
  import ItemLens from '../ItemLens.svelte';
  import { isRestricted, quotaOf, userLensLines, type UserRow } from './users';
  import QuotaBar from './QuotaBar.svelte';
  import PersonNotes from './PersonNotes.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    user = $bindable(null),
    accessMode,
    onchange,
  }: { user: UserRow | null; accessMode?: string; onchange?: () => void } = $props();

  let open = $state(false);

  $effect(() => {
    open = !!user;
  });

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
        {#if accessMode === 'allowlist' && user.allowlisted === false && !user.admin}<Badge tone="warn">{m.ppl_not_member()}</Badge>{/if}
        {#if isRestricted(user, accessMode)}<WhyButton subject={{ subject: 'block', pubkey: user.pubkey }} />{/if}
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
      <ItemLens lines={userLensLines(user)} />

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

      {#key user.pubkey}<PersonNotes pubkey={user.pubkey} />{/key}
    </div>
  {/if}
</Sheet>
