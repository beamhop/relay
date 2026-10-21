<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Command from '@lucide/svelte/icons/command';
  import Search from '@lucide/svelte/icons/search';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Code from '@lucide/svelte/icons/code';
  import { app } from '$lib/stores/app.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { to } from '$lib/nav';
  import TabBar from '$lib/components/shell/TabBar.svelte';
  import RelaySwitcher from '$lib/components/shell/RelaySwitcher.svelte';
  import OfflineBanner from '$lib/components/shell/OfflineBanner.svelte';
  import KeyboardHelp from '$lib/components/shell/KeyboardHelp.svelte';
  import Toaster from '$lib/components/Toaster.svelte';
  import ActionSheet from '$lib/components/ActionSheet.svelte';
  import ConfigDiffSheet from '$lib/components/ConfigDiffSheet.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import Onboarding from '$lib/components/onboarding/Onboarding.svelte';
  import SignIn from '$lib/components/onboarding/SignIn.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { children } = $props();
  let paletteOpen = $state(false);
  let helpOpen = $state(false);
  let pendingG = false;

  onMount(() => {
    prefs.applyTheme();
    void app.boot();
    const on = () => (app.online = true);
    const off = () => (app.online = false);
    addEventListener('online', on);
    addEventListener('offline', off);
    if (import.meta.env.PROD) {
      import('virtual:pwa-register')
        .then(({ registerSW }) => registerSW({ immediate: true }))
        .catch(() => {
          /* no service worker support */
        });
    }
    return () => {
      removeEventListener('online', on);
      removeEventListener('offline', off);
      live.stop();
    };
  });

  $effect(() => {
    if (app.phase === 'ready' && !app.onboarding) live.start();
    else live.stop();
  });

  // Presence ping (experience module): lets the server know an admin has the app open.
  $effect(() => {
    if (app.phase !== 'ready' || !app.hasAction('experience.ping')) return;
    const ping = () => {
      if (document.visibilityState === 'visible') void app.api.run('experience.ping', {}, 'node').catch(() => {});
    };
    ping();
    const t = setInterval(ping, 60_000);
    return () => clearInterval(t);
  });

  const showShell = $derived(app.phase === 'ready' && !app.onboarding);

  function typing(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest('input, textarea, select, [contenteditable="true"]');
  }

  function onkeydown(e: KeyboardEvent) {
    if (!showShell || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') {
      helpOpen = true;
      return;
    }
    if (e.key === 'u') {
      void toasts.undo();
      return;
    }
    if (e.key === 't') {
      prefs.toggleLens();
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      paletteOpen = true;
      return;
    }
    if (e.key === 'g') {
      pendingG = true;
      setTimeout(() => (pendingG = false), 800);
      return;
    }
    if (pendingG) {
      pendingG = false;
      const dest: Record<string, string> = { h: '/', a: '/activity', p: '/people', m: '/media', s: '/settings' };
      if (dest[e.key]) void goto(to(dest[e.key] as string));
    }
  }
</script>

<svelte:window {onkeydown} />

<OfflineBanner />

{#if app.phase === 'loading'}
  <main class="mx-auto max-w-md space-y-4 p-6 pt-16" aria-busy="true">
    <Skeleton class="h-8 w-40" />
    <Skeleton class="h-40 w-full" />
    <Skeleton class="h-24 w-full" />
  </main>
{:else if app.phase === 'unreachable'}
  <main class="mx-auto max-w-md p-6 pt-20 text-center">
    <h1 class="text-lg font-semibold">{m.boot_unreachable_title()}</h1>
    <p class="mt-2 text-sm text-muted-foreground">{m.boot_unreachable_body()}</p>
    {#if prefs.lens && app.bootError}<p class="mt-2 font-mono text-xs text-muted-foreground">{app.bootError.technical}</p>{/if}
    <Button class="mt-6" onclick={() => app.boot()}>{m.common_retry()}</Button>
  </main>
{:else if app.phase === 'claim' || (app.phase === 'ready' && app.onboarding)}
  <Onboarding />
{:else if app.phase === 'signin'}
  <SignIn />
{:else}
  <div class="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
    <aside class="sticky top-0 hidden h-dvh flex-col gap-4 border-r p-4 md:flex">
      <a href={to('/')} class="flex items-center gap-2 px-2 pt-1 text-sm font-semibold">
        <img src={to('/favicon.svg')} alt="" class="size-6" />
        {m.app_name()}
      </a>
      <button
        class="flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
        onclick={() => (paletteOpen = true)}
      >
        <Search class="size-4" />
        <span class="flex-1">{m.palette_search()}</span>
        <kbd class="rounded border px-1 text-[10px]">⌘K</kbd>
      </button>
      <TabBar variant="side" />
      <div class="mt-auto space-y-1">
        <button
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
          aria-pressed={prefs.lens}
          onclick={() => prefs.toggleLens()}
        >
          <Code class="size-4" />
          {prefs.lens ? m.lens_hide() : m.lens_show()}
        </button>
        <button
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
          onclick={() => app.signOut()}
        >
          <LogOut class="size-4" />
          {m.signout()}
        </button>
        <p class="truncate px-3 text-[11px] text-muted-foreground">{app.me?.displayName ?? ''}</p>
      </div>
    </aside>

    <div class="min-w-0">
      <header class="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/85 px-4 pt-safe backdrop-blur-xl md:px-8">
        <div class="flex h-14 flex-1 items-center gap-2">
          <img src={to('/favicon.svg')} alt="" class="size-6 md:hidden" />
          <span class="truncate text-sm font-semibold md:hidden">{app.relay?.name ?? m.app_name()}</span>
          <RelaySwitcher />
        </div>
        <button
          class="rounded-lg p-2 text-muted-foreground hover:bg-muted md:hidden"
          aria-label={m.palette_search()}
          onclick={() => (paletteOpen = true)}
        >
          <Search class="size-5" />
        </button>
      </header>

      <main class="mx-auto w-full max-w-5xl px-4 pt-4 pb-28 md:px-8 md:pb-12">
        <svelte:boundary>
          {@render children()}
          {#snippet failed(error, reset)}
            <ErrorPanel {error} {reset} />
          {/snippet}
        </svelte:boundary>
      </main>
    </div>

    <TabBar />

    <button
      class="fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 active:scale-95 md:hidden"
      aria-label={m.palette_open()}
      data-testid="fab"
      onclick={() => (paletteOpen = true)}
    >
      <Command class="size-5" />
    </button>
  </div>

  <CommandPalette bind:open={paletteOpen} />
  <KeyboardHelp bind:open={helpOpen} />
{/if}

<ActionSheet />
<ConfigDiffSheet />
<Toaster />
