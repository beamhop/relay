<script lang="ts">
  /** Sign in with a NIP-07 extension, a NIP-46 bunker, or a passkey (optionally redeeming a code). */
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Link from '@lucide/svelte/icons/link';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { passkeysSupported, registerPasskey, signInWithPasskey } from '$lib/auth/passkey';
  import type { SessionResponse } from '$lib/api/types';
  import Button from '../ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    claimCode,
    inviteCode,
    recoveryCode,
    newAccount = false,
    ondone,
  }: {
    claimCode?: string;
    inviteCode?: string;
    recoveryCode?: string;
    /** Passkey creates a new admin (claim/invite) instead of signing in. */
    newAccount?: boolean;
    ondone: (res: SessionResponse | null) => void;
  } = $props();

  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let showBunker = $state(false);
  let bunker = $state('');
  let authUrl = $state<string | null>(null);
  let displayName = $state('');

  const codes = $derived({
    ...(claimCode ? { claimCode } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    ...(recoveryCode ? { recoveryCode } : {}),
  });

  async function attempt(kind: string, fn: () => Promise<SessionResponse | null>) {
    busy = kind;
    error = null;
    try {
      ondone(await fn());
    } catch (err) {
      const e = asApiError(err);
      error = e.status === 0 && kind === 'nip07' ? m.signin_extension_failed() : e.message;
    } finally {
      busy = null;
    }
  }

  const viaExtension = () => attempt('nip07', () => app.signInWithNostr('nip07', codes));
  const viaBunker = () =>
    attempt('nip46', () =>
      app.signInWithNostr('nip46', { ...codes, bunker, onAuth: (u) => (authUrl = u) }),
    );
  const viaPasskey = () =>
    attempt('passkey', async () => {
      if (newAccount || claimCode || inviteCode) {
        const r = await registerPasskey(app.api, { ...codes, ...(displayName ? { displayName } : {}) });
        if ('token' in r) {
          if (r.recoveryCodes) app.recoveryCodes = r.recoveryCodes;
          return r;
        }
        return null;
      }
      return signInWithPasskey(app.api, recoveryCode);
    });
</script>

<div class="space-y-3">
  {#if app.extensionAvailable()}
    <Button size="lg" class="w-full justify-start" disabled={!!busy} onclick={viaExtension} data-testid="signin-extension">
      {#if busy === 'nip07'}<LoaderCircle class="size-4 animate-spin" />{:else}<Puzzle class="size-4" />{/if}
      <span class="flex-1 text-left">{m.signin_extension()}</span>
    </Button>
  {/if}

  {#if showBunker}
    <form
      class="space-y-2 rounded-xl border p-3"
      onsubmit={(e) => {
        e.preventDefault();
        void viaBunker();
      }}
    >
      <label for="bunker" class="text-sm font-medium">{m.signin_bunker_label()}</label>
      <input
        id="bunker"
        class="h-10 w-full rounded-lg border bg-background px-3 font-mono text-xs"
        placeholder="bunker://…"
        bind:value={bunker}
        autocomplete="off"
        required
      />
      {#if authUrl}
        <p class="text-xs">
          {m.signin_bunker_auth()} <a class="text-primary underline" href={authUrl} target="_blank" rel="noopener">{authUrl}</a>
        </p>
      {/if}
      <Button type="submit" class="w-full" disabled={!!busy || !bunker}>
        {#if busy === 'nip46'}<LoaderCircle class="size-4 animate-spin" />{/if}
        {m.signin_bunker_connect()}
      </Button>
    </form>
  {:else}
    <Button size="lg" variant="secondary" class="w-full justify-start" onclick={() => (showBunker = true)}>
      <Link class="size-4" />
      <span class="flex-1 text-left">{m.signin_bunker()}</span>
    </Button>
  {/if}

  {#if passkeysSupported()}
    {#if newAccount || claimCode || inviteCode}
      <input
        class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
        placeholder={m.signin_display_name()}
        aria-label={m.signin_display_name()}
        bind:value={displayName}
      />
    {/if}
    <Button size="lg" variant="secondary" class="w-full justify-start" disabled={!!busy} onclick={viaPasskey}>
      {#if busy === 'passkey'}<LoaderCircle class="size-4 animate-spin" />{:else}<KeyRound class="size-4" />{/if}
      <span class="flex-1 text-left">
        {newAccount || claimCode || inviteCode ? m.signin_passkey_create() : m.signin_passkey()}
      </span>
    </Button>
  {/if}

  {#if !app.extensionAvailable()}
    <p class="text-xs text-muted-foreground">{m.signin_no_extension()}</p>
  {/if}

  {#if error}
    <p class="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="signin-error">{error}</p>
  {/if}
</div>
