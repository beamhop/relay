<script lang="ts">
  /** Sign-in & recovery (§6.4, §6.11): recovery codes, passkeys, API tokens. */
  import { onMount } from 'svelte';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { markRecoverySaved, recoverySaved } from '$lib/checklist';
  import { passkeysSupported, registerPasskey } from '$lib/auth/passkey';
  import { to } from '$lib/nav';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let recovery = $state<{ remaining: number; owner: boolean } | null>(null);
  let saved = $state(recoverySaved());

  onMount(async () => {
    recovery = await app.api.recoveryStatus().catch(() => null);
  });

  function newCodes() {
    const def = app.action('admins.recovery-codes');
    if (!def) return;
    void flow.start(def, {}, {
      onDone: async () => {
        markRecoverySaved();
        saved = true;
        recovery = await app.api.recoveryStatus().catch(() => recovery);
      },
    });
  }

  async function addPasskey() {
    try {
      await registerPasskey(app.api, { label: navigator.userAgent.slice(0, 60) });
      toasts.success(m.security_passkey_added());
    } catch (err) {
      toasts.error(asApiError(err).message);
    }
  }

  function tokens() {
    const def = app.action('tokens.create');
    if (def) void flow.start(def, {}, { form: true });
  }
</script>

<svelte:head><title>{m.security_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.security_title()}</h1>

<div class="mt-4 space-y-4 md:max-w-xl">
  <section class="rounded-xl border p-4">
    <div class="flex items-center gap-2">
      <h2 class="flex-1 text-sm font-medium">{m.security_recovery()}</h2>
      {#if recovery}<Badge tone={recovery.remaining > 2 ? 'ok' : 'warn'}>{m.security_codes_left({ count: recovery.remaining })}</Badge>{/if}
    </div>
    <p class="mt-1 text-sm text-muted-foreground">{m.security_recovery_desc()}</p>
    {#if !saved}<p class="mt-2 text-xs text-warning">{m.security_recovery_unsaved()}</p>{/if}
    <div class="mt-3 flex flex-wrap gap-2">
      {#if app.hasAction('admins.recovery-codes') && recovery?.owner}
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

  {#if app.hasAction('tokens.create')}
    <section class="rounded-xl border p-4">
      <h2 class="text-sm font-medium">{m.security_tokens()}</h2>
      <p class="mt-1 text-sm text-muted-foreground">{m.security_tokens_desc()}</p>
      <Button size="sm" variant="secondary" class="mt-3" onclick={tokens}>{m.security_new_token()}</Button>
    </section>
  {/if}
</div>
