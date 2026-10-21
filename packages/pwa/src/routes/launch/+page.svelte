<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Launch kit (§7 first week): the address and QR code to share, a draft
   * announcement to copy (never posted by Beamhop), the relay-profile polish
   * checklist (each item opens its setting) and "Test my relay".
   */
  import { onMount } from 'svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Globe from '@lucide/svelte/icons/globe';
  import { app } from '$lib/stores/app.svelte';
  import { flow, withContext } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { polishTarget, type LaunchKitOutput } from '$lib/checklist';
  import { to } from '$lib/nav';
  import QrCode from '$lib/components/QrCode.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let kit = $state<LaunchKitOutput | null>(null);
  let error = $state<unknown>(null);
  let absent = $state(false);
  let copied = $state<string | null>(null);

  async function load() {
    error = null;
    const def = app.action('experience.launch-kit');
    if (!def || !app.relayId) {
      absent = true;
      return;
    }
    try {
      kit = (await app.api.run<LaunchKitOutput>(def.id, withContext(def.id, {}), def.scope)).output;
    } catch (err) {
      error = err;
    }
  }
  onMount(load);

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      toasts.show({ message: m.common_copied(), kind: 'success' }, 2500);
      setTimeout(() => (copied = copied === what ? null : copied), 2000);
    } catch {
      toasts.error(m.common_copy_failed());
    }
  }

  function testNow() {
    const def = app.action('experience.test-relay');
    if (def) void flow.start(def, {});
  }
</script>

<svelte:head><title>{m.launch_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/')} class="text-sm text-muted-foreground">← {m.nav_home()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.launch_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.launch_intro()}</p>

<div class="mt-6 space-y-5" data-testid="launch-kit">
  {#if error}<ErrorPanel {error} reset={load} />{/if}
  {#if absent}
    <p class="rounded-xl border border-dashed p-5 text-sm text-muted-foreground" data-testid="launch-absent">{m.launch_absent()}</p>
  {:else if !kit && !error}
    <Skeleton class="h-56 w-full" />
  {:else if kit}
    {#if kit.needsDomain}
      <section class="rounded-xl border border-warning/40 bg-warning/10 p-4" data-testid="launch-needs-domain">
        <div class="flex items-center gap-2"><Globe class="size-4 text-warning" /><p class="text-sm font-medium">{m.launch_needs_domain()}</p></div>
        <p class="mt-1 text-sm text-muted-foreground">{kit.summary}</p>
        <Button size="sm" class="mt-3" href={to(kit.link?.screen ?? '/settings/domains')}>{m.launch_add_domain()}</Button>
        <ItemLens lines={kit.technical ? [kit.technical] : []} />
      </section>
    {:else}
      <section class="rounded-xl border bg-card p-4" aria-labelledby="launch-address" data-testid="launch-address">
        <h2 id="launch-address" class="text-sm font-medium">{m.launch_address()}</h2>
        <div class="mt-3 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <QrCode value={kit.urls.relay} label={m.launch_qr_label()} />
          <div class="w-full min-w-0 space-y-3">
            <div class="flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-sm" data-testid="launch-relay-url">{kit.urls.relay}</code>
              <Button size="sm" variant="secondary" aria-label={m.launch_copy_address()} onclick={() => copy('relay', kit && !kit.needsDomain ? kit.urls.relay : '')}>
                {#if copied === 'relay'}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
              </Button>
            </div>
            {#if kit.urls.blossom}
              <p class="text-xs text-muted-foreground">{m.launch_media_address()}: <span class="break-all">{kit.urls.blossom}</span></p>
            {/if}
            <a href={kit.urls.landing} target="_blank" rel="noopener" class="block text-sm text-primary">{m.launch_landing()} ↗</a>
            <ItemLens lines={[`NIP-11: ${kit.urls.nip11}`, `source: ${kit.urlSource ?? 'host'}`]} />
          </div>
        </div>
      </section>

      <section class="rounded-xl border bg-card p-4" aria-labelledby="launch-announce" data-testid="launch-announcement">
        <h2 id="launch-announce" class="text-sm font-medium">{m.launch_announce_title()}</h2>
        <p class="mt-1 text-xs text-muted-foreground">{m.launch_announce_hint()}</p>
        <pre class="mt-3 whitespace-pre-wrap rounded-lg bg-muted p-3 font-sans text-sm" data-testid="launch-post">{kit.announcement.text}</pre>
        <Button class="mt-3" size="sm" onclick={() => copy('post', kit && !kit.needsDomain ? kit.announcement.text : '')} data-testid="launch-copy-post">
          {#if copied === 'post'}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
          {m.launch_copy_post()}
        </Button>
        <ItemLens lines={[`unsigned kind ${kit.announcement.draft?.kind ?? 1} draft, published: false`]} />
      </section>
    {/if}

    <section class="rounded-xl border bg-card p-4" aria-labelledby="launch-polish" data-testid="launch-polish">
      <h2 id="launch-polish" class="text-sm font-medium">{m.launch_polish_title()}</h2>
      <p class="mt-1 text-xs text-muted-foreground">{m.launch_polish_hint()}</p>
      {#if kit.polish.length === 0}
        <p class="mt-3 flex items-center gap-2 text-sm" data-testid="launch-polish-done"><Check class="size-4 text-success" />{m.launch_polish_done()}</p>
      {:else}
        <ul class="mt-2 divide-y">
          {#each kit.polish as p (p.field)}
            {@const t = polishTarget(p)}
            <li class="py-2" data-testid="polish-item" data-field={p.field}>
              <a href={to(t.href)} class="flex items-center gap-3 text-sm">
                <span class="min-w-0 flex-1">{p.text}</span>
                {#if p.importance === 'nice-to-have'}<Badge>{m.launch_polish_optional()}</Badge>{/if}
                <span class="text-xs text-primary">{m.launch_polish_fix()}</span>
                <ChevronRight class="size-4 text-muted-foreground" />
              </a>
              <ItemLens lines={t.lens} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if app.hasAction('experience.test-relay')}
      <section class="rounded-xl border bg-card p-4" aria-labelledby="launch-test" data-testid="launch-test">
        <h2 id="launch-test" class="text-sm font-medium">{m.launch_test_title()}</h2>
        <p class="mt-1 text-xs text-muted-foreground">{m.launch_test_hint()}</p>
        <Button class="mt-3" size="sm" onclick={testNow} data-testid="launch-test-run">{m.launch_test_run()}</Button>
      </section>
    {/if}
  {/if}
</div>
