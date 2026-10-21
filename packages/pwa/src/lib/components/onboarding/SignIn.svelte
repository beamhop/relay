<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Building2 from '@lucide/svelte/icons/building-2';
  import { app } from '$lib/stores/app.svelte';
  import Button from '../ui/button.svelte';
  import SignInMethods from './SignInMethods.svelte';
  import { to } from '$lib/nav';
  import { m } from '$lib/paraglide/messages.js';

  let mode = $state<'signin' | 'invite' | 'recovery'>('signin');
  let code = $state('');
  let sso = $state<Array<{ id: string; label: string; startUrl: string }>>([]);

  onMount(async () => {
    sso = await app.api.ssoProviders();
  });

  function ssoHref(startUrl: string): string {
    const u = new URL(startUrl, location.origin);
    u.searchParams.set('audience', 'admin');
    u.searchParams.set('returnTo', location.pathname);
    return u.toString();
  }

  async function done() {
    await app.loadSession();
  }
</script>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6" data-testid="signin">
  <div>
    <img src={to('/favicon.svg')} alt="" class="mb-6 size-10" />
    <h1 class="text-2xl font-semibold tracking-tight">{m.signin_title()}</h1>
    <p class="mt-1 text-sm text-muted-foreground">{m.signin_subtitle()}</p>
  </div>

  {#if mode !== 'signin'}
    <label class="block space-y-1.5">
      <span class="text-sm font-medium">{mode === 'invite' ? m.signin_invite_code() : m.signin_recovery_code()}</span>
      <input
        class="h-11 w-full rounded-lg border bg-background px-3 font-mono tracking-wider uppercase"
        bind:value={code}
        autocomplete="one-time-code"
      />
    </label>
  {/if}

  {#if sso.length && mode === 'signin'}
    <div class="space-y-2" data-testid="sso-buttons">
      {#each sso as p (p.id)}
        <Button size="lg" variant="secondary" class="w-full justify-start" href={ssoHref(p.startUrl)}>
          <Building2 class="size-4" /><span class="flex-1 text-left">{m.signin_sso({ label: p.label })}</span>
        </Button>
      {/each}
      <p class="text-center text-xs text-muted-foreground">{m.signin_or()}</p>
    </div>
  {/if}

  <SignInMethods
    inviteCode={mode === 'invite' ? code.trim() : undefined}
    recoveryCode={mode === 'recovery' ? code.trim() : undefined}
    newAccount={mode === 'invite'}
    ondone={done}
  />

  <div class="flex justify-center gap-4 text-xs text-muted-foreground">
    {#if mode !== 'invite'}<button class="hover:text-foreground" onclick={() => (mode = 'invite')}>{m.signin_have_invite()}</button>{/if}
    {#if mode !== 'recovery'}<button class="hover:text-foreground" onclick={() => (mode = 'recovery')}>{m.signin_lost_access()}</button>{/if}
    {#if mode !== 'signin'}<button class="hover:text-foreground" onclick={() => (mode = 'signin')}>{m.signin_back()}</button>{/if}
  </div>
</main>
