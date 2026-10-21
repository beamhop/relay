<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Sign-in & recovery (§6.4, §6.11): recovery checklist, owners, recovery codes, passkeys, API tokens. */
  import { onMount } from 'svelte';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Circle from '@lucide/svelte/icons/circle';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow, query } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { markRecoverySaved, recoverySaved } from '$lib/checklist';
  import { passkeysSupported, registerPasskey } from '$lib/auth/passkey';
  import { forgetKey, rememberedKey } from '$lib/auth/local-key';
  import { to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import TokenList from './TokenList.svelte';
  import { recoveryChecklist, type RecoveryStatus } from './security';
  import { m } from '$lib/paraglide/messages.js';

  let recovery = $state<{ remaining: number; owner: boolean } | null>(null);
  let status = $state<RecoveryStatus | null>(null);
  let saved = $state(recoverySaved());
  let keyStored = $state(!!rememberedKey());

  const checklist = $derived(status ? recoveryChecklist(status, saved) : []);
  const isOwner = $derived(status?.owner ?? recovery?.owner ?? false);

  function forgetDevice() {
    forgetKey();
    keyStored = false;
    toasts.show({ message: m.security_device_forgotten(), kind: 'info' });
  }

  async function loadStatus() {
    status = await query<RecoveryStatus>('admins.recovery-status');
    if (status) {
      names.rememberRows(status.owners);
      if (status.recoveryCodesLeft !== null) recovery = { remaining: status.recoveryCodesLeft, owner: status.owner };
    }
    if (!status || status.recoveryCodesLeft === null) recovery = await app.api.recoveryStatus().catch(() => recovery);
  }

  onMount(loadStatus);

  function newCodes() {
    const def = app.action('admins.recovery-codes');
    if (!def) return;
    void flow.start(def, {}, {
      onDone: async () => {
        markRecoverySaved();
        saved = true;
        await loadStatus();
      },
    });
  }

  function addOwner() {
    const def = app.action('admins.invite');
    if (!def) return;
    void flow.start(def, { role: 'owner' }, { form: true, onDone: () => void loadStatus(), onUndo: () => void loadStatus() });
  }

  async function addPasskey() {
    try {
      await registerPasskey(app.api, { label: navigator.userAgent.slice(0, 60) });
      toasts.success(m.security_passkey_added());
      await loadStatus();
    } catch (err) {
      toasts.error(asApiError(err).message);
    }
  }
</script>

<svelte:head><title>{m.security_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.security_title()}</h1>

<div class="mt-4 space-y-4 md:max-w-xl">
  {#if checklist.length}
    <section class="rounded-xl border p-4" data-testid="recovery-checklist">
      <h2 class="text-sm font-medium">{m.ppl_sec_checklist()}</h2>
      <p class="mt-1 text-sm text-muted-foreground">{m.ppl_sec_checklist_desc()}</p>
      <ul class="mt-3 space-y-2">
        {#each checklist as c (c.id)}
          <li class="flex items-center gap-2 text-sm" data-check={c.id} data-done={c.done ? 'true' : 'false'}>
            {#if c.done}<CircleCheck class="size-4 text-success" />{:else}<Circle class="size-4 text-muted-foreground" />{/if}
            <span class={cn(!c.done && 'text-muted-foreground')}>{c.label}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if status}
    <section class="rounded-xl border p-4" data-testid="owners">
      <h2 class="text-sm font-medium">{m.ppl_sec_owners()}</h2>
      <p class="mt-1 text-sm text-muted-foreground">{m.ppl_sec_owners_desc()}</p>
      <ul class="mt-3 divide-y rounded-lg border">
        {#each status.owners as o (o.id)}
          <li class="flex items-center gap-3 p-3" data-testid="owner-row">
            <div class="flex size-8 items-center justify-center rounded-full bg-muted text-sm font-medium">{o.displayName.slice(0, 1).toUpperCase()}</div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{o.pubkey ? (names.nameOf(o.pubkey) ?? o.displayName) : o.displayName}</p>
              <ItemLens lines={[o.id, 'roles[*] = owner']} />
            </div>
            {#if o.id === app.me?.id}<Badge>{m.team_you()}</Badge>{/if}
          </li>
        {/each}
      </ul>
      {#if status.owners.length < 2}<p class="mt-2 text-xs text-warning">{m.ppl_sec_only_owner()}</p>{/if}
      {#if app.hasAction('admins.invite') && isOwner}
        <Button size="sm" variant={status.owners.length < 2 ? 'default' : 'secondary'} class="mt-3" onclick={addOwner} data-testid="add-owner">
          <UserPlus class="size-4" />{m.ppl_sec_add_owner()}
        </Button>
      {:else if !isOwner}
        <p class="mt-2 text-xs text-muted-foreground">{m.ppl_sec_owner_only()}</p>
      {/if}
    </section>
  {/if}

  <section class="rounded-xl border p-4">
    <div class="flex items-center gap-2">
      <h2 class="flex-1 text-sm font-medium">{m.security_recovery()}</h2>
      {#if recovery}<Badge tone={recovery.remaining > 2 ? 'ok' : 'warn'}>{m.security_codes_left({ count: recovery.remaining })}</Badge>{/if}
    </div>
    <p class="mt-1 text-sm text-muted-foreground">{m.security_recovery_desc()}</p>
    {#if !saved}<p class="mt-2 text-xs text-warning">{m.security_recovery_unsaved()}</p>{/if}
    <div class="mt-3 flex flex-wrap gap-2">
      {#if app.hasAction('admins.recovery-codes') && isOwner}
        <Button size="sm" variant="secondary" onclick={newCodes}>{m.security_new_codes()}</Button>
      {/if}
      {#if !saved}
        <Button size="sm" variant="ghost" onclick={() => (markRecoverySaved(), (saved = true))}>{m.security_mark_saved()}</Button>
      {/if}
    </div>
  </section>

  {#if passkeysSupported()}
    <section class="rounded-xl border p-4">
      <h2 class="text-sm font-medium">{m.security_passkeys()}</h2>
      <p class="mt-1 text-sm text-muted-foreground">{m.security_passkeys_desc()}</p>
      <Button size="sm" variant="secondary" class="mt-3" onclick={addPasskey}><KeyRound class="size-4" />{m.security_add_passkey()}</Button>
    </section>
  {/if}

  <section class="rounded-xl border p-4" data-testid="device-key">
    <h2 class="text-sm font-medium">{m.security_device()}</h2>
    <p class="mt-1 text-sm text-muted-foreground">{keyStored ? m.security_device_stored() : m.security_device_none()}</p>
    {#if keyStored}
      <Button size="sm" variant="destructive" class="mt-3" onclick={forgetDevice} data-testid="forget-device">{m.key_forget_device()}</Button>
    {/if}
  </section>

  {#if app.hasAction('tokens.create') || app.hasAction('tokens.list')}
    <TokenList />
  {/if}
</div>
