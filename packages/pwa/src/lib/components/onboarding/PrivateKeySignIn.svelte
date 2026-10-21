<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Sign in with your private key" (nsec / hex / ncryptsec). The key stays in
   * this page's memory for the session and signs the login locally; it is never
   * sent to the server. Optional: remember it on this device, encrypted with a
   * password (NIP-49). An extension or remote signer is safer, and we say so.
   */
  import Key from '@lucide/svelte/icons/key';
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import {
    decryptKey,
    forgetKey,
    parseKeyInput,
    rememberedKey,
    rememberKey,
    type RememberedKey,
  } from '$lib/auth/local-key';
  import type { SessionResponse } from '$lib/api/types';
  import Button from '../ui/button.svelte';
  import { short } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  let {
    codes,
    disabled = false,
    ondone,
    onbusy,
  }: {
    codes: { claimCode?: string; inviteCode?: string; recoveryCode?: string };
    disabled?: boolean;
    ondone: (res: SessionResponse) => void;
    onbusy?: (busy: boolean) => void;
  } = $props();

  const MIN_PASSWORD = 8;

  let stored = $state<RememberedKey | null>(rememberedKey());
  let open = $state(false);
  let keyText = $state('');
  let keyPassword = $state('');
  let remember = $state(false);
  let newPassword = $state('');
  let confirmPassword = $state('');
  let unlockPassword = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const encrypted = $derived(/^ncryptsec1/i.test(keyText.trim()));

  function setBusy(v: boolean) {
    busy = v;
    onbusy?.(v);
  }

  function clear() {
    keyText = '';
    keyPassword = '';
    newPassword = '';
    confirmPassword = '';
    unlockPassword = '';
  }

  async function signIn(sk: Uint8Array): Promise<SessionResponse> {
    try {
      return await app.signInWithKey(sk, codes);
    } finally {
      sk.fill(0);
    }
  }

  async function submit() {
    error = null;
    if (remember && !encrypted) {
      if (newPassword.length < MIN_PASSWORD) {
        error = m.key_password_short({ min: MIN_PASSWORD });
        return;
      }
      if (newPassword !== confirmPassword) {
        error = m.key_password_mismatch();
        return;
      }
    }
    setBusy(true);
    try {
      const parsed = await parseKeyInput(keyText);
      if (parsed.kind === 'public') {
        error = m.key_is_public();
        return;
      }
      if (parsed.kind === 'invalid') {
        error = m.key_invalid();
        return;
      }
      let sk: Uint8Array;
      if (parsed.kind === 'encrypted') {
        try {
          sk = await decryptKey(parsed.ncryptsec, keyPassword);
        } catch {
          error = m.key_wrong_password();
          return;
        }
      } else sk = parsed.sk;
      // Encrypt before signing in: `signIn` wipes the bytes afterwards.
      const toRemember = remember ? new Uint8Array(sk) : null;
      const res = await signIn(sk);
      if (toRemember) {
        try {
          await rememberKey(toRemember, encrypted ? keyPassword : newPassword);
          stored = rememberedKey();
        } finally {
          toRemember.fill(0);
        }
      }
      clear();
      ondone(res);
    } catch (err) {
      error = asApiError(err).message;
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (!stored) return;
    error = null;
    setBusy(true);
    try {
      let sk: Uint8Array;
      try {
        sk = await decryptKey(stored.ncryptsec, unlockPassword);
      } catch {
        error = m.key_wrong_password();
        return;
      }
      const res = await signIn(sk);
      clear();
      ondone(res);
    } catch (err) {
      error = asApiError(err).message;
    } finally {
      setBusy(false);
    }
  }

  function forget() {
    forgetKey();
    stored = null;
    clear();
  }
</script>

{#if stored && !open}
  <form
    class="space-y-2 rounded-xl border p-3"
    data-testid="signin-unlock"
    onsubmit={(e) => {
      e.preventDefault();
      void unlock();
    }}
  >
    <div class="flex items-center gap-2">
      <LockKeyhole class="size-4 text-primary" />
      <p class="flex-1 text-sm font-medium">{m.key_unlock_title()}</p>
    </div>
    <p class="text-xs text-muted-foreground">
      {m.key_unlock_desc()}
      {#if prefs.lens}<span class="font-mono" data-lens>{short(stored.pubkey, 8)}</span>{/if}
    </p>
    <input
      type="password"
      class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
      placeholder={m.key_password()}
      aria-label={m.key_password()}
      autocomplete="current-password"
      bind:value={unlockPassword}
      data-testid="unlock-password"
    />
    <Button type="submit" class="w-full" disabled={disabled || busy || !unlockPassword} data-testid="unlock-submit">
      {#if busy}<LoaderCircle class="size-4 animate-spin" />{/if}
      {m.key_unlock()}
    </Button>
    <div class="flex justify-between text-xs text-muted-foreground">
      <button type="button" class="hover:text-foreground" onclick={() => (open = true)}>{m.key_use_other()}</button>
      <button type="button" class="hover:text-foreground" onclick={forget} data-testid="unlock-forget">{m.key_forget_device()}</button>
    </div>
    {#if error}<p class="text-sm text-destructive" role="alert" data-testid="key-error">{error}</p>{/if}
  </form>
{:else if open}
  <form
    class="space-y-2 rounded-xl border p-3"
    data-testid="key-form"
    autocomplete="off"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <label for="private-key" class="text-sm font-medium">{m.key_label()}</label>
    <p class="flex gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning" data-testid="key-warning">
      <ShieldAlert class="mt-0.5 size-3.5 shrink-0" />{m.key_safer()}
    </p>
    <input
      id="private-key"
      type="password"
      class="h-10 w-full rounded-lg border bg-background px-3 font-mono text-xs"
      placeholder="nsec1… / ncryptsec1…"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      bind:value={keyText}
      data-testid="key-input"
      required
    />
    {#if encrypted}
      <input
        type="password"
        class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
        placeholder={m.key_password()}
        aria-label={m.key_password()}
        autocomplete="current-password"
        bind:value={keyPassword}
        data-testid="key-password"
      />
    {/if}
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" class="size-4 accent-[var(--primary)]" bind:checked={remember} data-testid="key-remember" />
      {m.key_remember()}
    </label>
    {#if remember}
      <p class="text-xs text-muted-foreground">{encrypted ? m.key_remember_same() : m.key_remember_desc()}</p>
      {#if !encrypted}
        <input
          type="password"
          class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
          placeholder={m.key_new_password()}
          aria-label={m.key_new_password()}
          autocomplete="new-password"
          bind:value={newPassword}
          data-testid="remember-password"
        />
        <input
          type="password"
          class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
          placeholder={m.key_confirm_password()}
          aria-label={m.key_confirm_password()}
          autocomplete="new-password"
          bind:value={confirmPassword}
          data-testid="remember-confirm"
        />
      {/if}
    {/if}
    <Button type="submit" class="w-full" disabled={disabled || busy || !keyText.trim()} data-testid="key-submit">
      {#if busy}<LoaderCircle class="size-4 animate-spin" />{/if}
      {m.key_submit()}
    </Button>
    <p class="text-[11px] text-muted-foreground">{m.key_memory_only()}</p>
    {#if error}<p class="text-sm text-destructive" role="alert" data-testid="key-error">{error}</p>{/if}
  </form>
{/if}

{#if !open}
  <Button size="lg" variant="secondary" class="w-full justify-start" disabled={disabled} onclick={() => (open = true)} data-testid="signin-key">
    <Key class="size-4" />
    <span class="flex-1 text-left">{m.key_option()}</span>
  </Button>
{/if}
