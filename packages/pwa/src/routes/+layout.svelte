<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Command from '@lucide/svelte/icons/command';
  import Search from '@lucide/svelte/icons/search';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Code from '@lucide/svelte/icons/code';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { app } from '$lib/stores/app.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { assistant } from '$lib/stores/assistant.svelte';
  import { names } from '$lib/stores/names.svelte';
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
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { children } = $props();
  let paletteOpen = $state(false);
  let helpOpen = $state(false);
  let pendingG = false;
  // The assistant panel is loaded on first open (keeps it out of the first-load bundle).
  let assistantLoaded = $state(false);
  $effect(() => {
    if (assistant.open) assistantLoaded = true;
  });

  /** Floating button: the assistant when the AI module is installed, else the command palette. */
  function fab() {
    if (assistant.installed) assistant.show();
    else paletteOpen = true;
  }

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

  // People names for public keys (team list + signed-in admin), once per relay.
  $effect(() => {
    if (app.phase === 'ready' && !app.onboarding) void names.ensure(app.relayId);
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
  {#await import('$lib/components/onboarding/Onboarding.svelte') then { default: Onboarding }}
    <Onboarding />
  {/await}
{:else if app.phase === 'signin'}
  {#await import('$lib/components/onboarding/SignIn.svelte') then { default: SignIn }}
    <SignIn />
  {/await}
{:else}
  <div class="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
    <aside class="sticky top-0 hidden h-dvh flex-col gap-4 border-r p-4 md:flex">
      <a href={to('/')} class="flex items-center gap-2 rounded-lg px-2 pt-1 text-sm font-semibold hover:opacity-80" aria-label={m.brand_home()} data-testid="brand-home">
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
      <!-- Always shown: with AI off the panel says so and links to Settings › AI assistant. -->
      <button
        class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
        data-testid="assistant-open"
        data-installed={assistant.installed}
        onclick={() => assistant.show()}
      >
        <Sparkles class={assistant.installed ? 'size-4 text-primary' : 'size-4 text-muted-foreground'} />
        <span class="flex-1">{m.assistant_open()}</span>
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
          <a href={to('/')} class="flex min-w-0 items-center gap-2 md:hidden" aria-label={m.brand_home()} data-testid="brand-home-mobile">
            <img src={to('/favicon.svg')} alt="" class="size-6" />
            <span class="truncate text-sm font-semibold">{app.relay?.name ?? m.app_name()}</span>
          </a>
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
      aria-label={assistant.installed ? m.assistant_open() : m.palette_open()}
      data-testid="fab"
      data-mode={assistant.installed ? 'assistant' : 'palette'}
      onclick={fab}
    >
      {#if assistant.installed}<Sparkles class="size-5" />{:else}<Command class="size-5" />{/if}
    </button>
  </div>

  <CommandPalette bind:open={paletteOpen} onassistant={() => assistant.show()} />
  {#if assistantLoaded}
    {#await import('$lib/components/assistant/AssistantPanel.svelte') then { default: AssistantPanel }}
      <AssistantPanel bind:open={assistant.open} onpalette={() => (paletteOpen = true)} />
    {/await}
  {/if}
  <KeyboardHelp bind:open={helpOpen} />
{/if}

<ActionSheet />
<ConfigDiffSheet />
<Toaster />
