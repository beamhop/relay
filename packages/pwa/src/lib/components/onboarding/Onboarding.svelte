<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * 60-second wizard (§7): claim → sign in → persona → domain + TLS → done
   * (relay URL, Blossom URL, QR, share, phone alerts) → save recovery codes.
   * "Company / Organization" adds a company sign-in step (turn it on, connect
   * Google / Microsoft / another provider, map groups); it can be finished later.
   */
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Share2 from '@lucide/svelte/icons/share-2';
  import Bell from '@lucide/svelte/icons/bell';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Building2 from '@lucide/svelte/icons/building-2';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow, runNow } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { personas } from '$lib/personas';
  import { enablePush } from '$lib/push';
  import { markRecoverySaved } from '$lib/checklist';
  import type { Persona, SelfCheck } from '$lib/api/types';
  import SignInMethods from './SignInMethods.svelte';
  import QrCode from '../QrCode.svelte';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import { cn } from '$lib/utils';
  import { to } from '$lib/nav';
  import { m } from '$lib/paraglide/messages.js';

  type Step = 'claim' | 'persona' | 'org' | 'domain' | 'done' | 'recovery';
  const ORDER: Step[] = ['claim', 'persona', 'domain', 'done', 'recovery'];

  const step = $derived<Step>(app.phase === 'claim' ? 'claim' : ((app.onboarding as Step | null) ?? 'persona'));
  const index = $derived(Math.max(0, ORDER.indexOf(step === 'org' ? 'persona' : step)));

  let claimCode = $state('');
  let persona = $state<Persona | null>(null);
  let busy = $state(false);
  let host = $state('');
  let check = $state<SelfCheck | null>(null);
  let checkError = $state<string | null>(null);
  let savedCodes = $state(false);
  let pushState = $state<string | null>(null);

  onMount(() => {
    const q = new URLSearchParams(location.search);
    claimCode = q.get('code') ?? q.get('claim') ?? '';
    host = location.hostname === 'localhost' || /^[\d.]+$/.test(location.hostname) ? '' : location.hostname;
  });

  $effect(() => {
    if (step === 'domain' && !check) void runCheck();
  });

  function go(s: Step) {
    app.setOnboarding(s);
  }

  async function claimed() {
    app.setOnboarding('persona');
    await app.loadSession();
  }

  async function choosePersona(p: Persona) {
    persona = p;
    if (p === 'organization') {
      go('org');
      return;
    }
    await applyPersona(p);
  }

  async function applyPersona(p: Persona) {
    busy = true;
    const r = await runNow('config.apply-persona', { persona: p });
    busy = false;
    if (r) {
      await app.reloadRelays();
      go('domain');
    }
  }

  async function runCheck() {
    checkError = null;
    try {
      check = await app.api.selfCheck();
    } catch (err) {
      checkError = asApiError(err).message;
    }
  }

  async function saveDomain() {
    const clean = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!clean) {
      go('done');
      return;
    }
    busy = true;
    try {
      const idx = Math.max(0, app.relays.findIndex((r) => r.id === app.relayId));
      // Keep existing hosts (e.g. the `*` catch-all) so the server stays reachable by IP.
      const hosts = [clean, ...(app.relay?.hosts ?? []).filter((h) => h !== clean)];
      const proposal = await app.api.propose({
        patch: [{ op: 'replace', path: `/relays/${idx}/hosts`, value: hosts }],
        summary: m.wizard_domain_summary({ host: clean }),
      });
      if (proposal.changed) {
        const r = await app.api.commit(proposal.id);
        toasts.success(r.revision.summary || m.settings_saved());
      }
      host = clean;
      await app.reloadRelays();
      go('done');
    } catch (err) {
      const e = asApiError(err);
      toasts.error(e.message, e.technical);
    } finally {
      busy = false;
    }
  }

  const publicHost = $derived(app.relay?.hosts.find((h) => h !== '*') ?? (host || location.host));
  const secure = $derived(check?.tls === 'acme' || check?.seen?.proto === 'https' || location.protocol === 'https:');
  const relayUrl = $derived(`${secure ? 'wss' : 'ws'}://${publicHost}`);
  const blossomUrl = $derived(`${secure ? 'https' : 'http'}://${publicHost}`);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show({ message: m.common_copied(), kind: 'info' });
    } catch {
      toasts.error(m.common_copy_failed());
    }
  }

  async function share() {
    const url = blossomUrl;
    if (navigator.share) {
      try {
        await navigator.share({ title: app.relay?.name ?? 'Nostr relay', url });
        return;
      } catch {
        /* cancelled */
      }
    }
    await copy(url);
  }

  async function alerts() {
    try {
      const r = await enablePush(app.api, app.catalog);
      pushState = r;
      if (r === 'enabled') toasts.success(m.push_enabled());
    } catch (err) {
      toasts.error(asApiError(err).message);
    }
  }

  function downloadCodes() {
    const blob = new Blob([`${m.recovery_file_header()}\n\n${(app.recoveryCodes ?? []).join('\n')}\n`], {
      type: 'text/plain',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'beamhop-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function finish() {
    markRecoverySaved();
    app.recoveryCodes = null;
    app.setOnboarding(null);
  }
</script>

<main class="mx-auto flex min-h-dvh max-w-md flex-col p-6 pt-[max(env(safe-area-inset-top),24px)]" data-testid="onboarding" data-step={step}>
  <div class="mb-8 flex items-center gap-2">
    <img src={to('/favicon.svg')} alt="" class="size-7" />
    <ol class="ml-auto flex gap-1.5" aria-label={m.wizard_progress()}>
      {#each ORDER as s, i (s)}
        <li class={cn('h-1.5 w-6 rounded-full', i <= index ? 'bg-primary' : 'bg-muted')} aria-current={i === index ? 'step' : undefined}></li>
      {/each}
    </ol>
  </div>

  {#if step === 'claim'}
    <h1 class="text-2xl font-semibold tracking-tight">{m.wizard_claim_title()}</h1>
    <p class="mt-2 text-sm text-muted-foreground">{m.wizard_claim_body()}</p>
    <label class="mt-6 block space-y-1.5">
      <span class="text-sm font-medium">{m.wizard_claim_code()}</span>
      <input
        class="h-12 w-full rounded-lg border bg-background px-3 text-center font-mono text-lg tracking-[0.2em] uppercase"
        placeholder="XXXX-XXXX-XXXX"
        bind:value={claimCode}
        autocomplete="one-time-code"
        data-testid="claim-code"
      />
    </label>
    <p class="mt-6 mb-3 text-sm font-medium">{m.wizard_claim_signin()}</p>
    {#if claimCode.trim().length >= 4}
      <SignInMethods claimCode={claimCode.trim()} newAccount ondone={claimed} />
    {:else}
      <p class="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{m.wizard_claim_need_code()}</p>
    {/if}
  {:else if step === 'persona'}
    <h1 class="text-2xl font-semibold tracking-tight">{m.wizard_persona_title()}</h1>
    <p class="mt-2 text-sm text-muted-foreground">{m.wizard_persona_body()}</p>
    <div class="mt-6 grid gap-2" role="radiogroup" aria-label={m.wizard_persona_title()}>
      {#each personas() as p (p.id)}
        <button
          role="radio"
          aria-checked={persona === p.id}
          disabled={busy}
          data-testid={`persona-${p.id}`}
          class={cn(
            'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/60',
            persona === p.id && 'border-primary bg-accent/40',
          )}
          onclick={() => choosePersona(p.id)}
        >
          <span class="text-xl" aria-hidden="true">{p.emoji}</span>
          <span class="min-w-0">
            <span class="block text-sm font-medium">{p.title}</span>
            <span class="block text-xs text-muted-foreground">{p.description}</span>
          </span>
        </button>
      {/each}
    </div>
    <p class="mt-4 text-xs text-muted-foreground">{m.wizard_persona_later()}</p>
  {:else if step === 'org'}
    <div class="flex flex-1 flex-col">
      <Building2 class="size-8 text-muted-foreground" />
      <h1 class="mt-4 text-2xl font-semibold tracking-tight">{m.wizard_org_title()}</h1>
      <p class="mt-2 text-sm text-muted-foreground" data-testid="org-intro">{m.wizard_org_body()}</p>
      <div class="mt-4">
        <!-- Lazy: company sign-in text only downloads after picking the Organization persona (§12.0). -->
        {#await import('../company/CompanySignIn.svelte') then { default: CompanySignIn }}
          <CompanySignIn compact />
        {/await}
      </div>
      <p class="mt-3 text-xs text-muted-foreground">{m.wizard_org_later()}</p>
      <div class="mt-auto flex gap-2 pt-8">
        <Button variant="secondary" class="flex-1" onclick={() => go('persona')}>{m.common_back()}</Button>
        <Button class="flex-1" disabled={busy} onclick={() => applyPersona('organization')}>{m.common_continue()}</Button>
      </div>
    </div>
  {:else if step === 'domain'}
    <h1 class="text-2xl font-semibold tracking-tight">{m.wizard_domain_title()}</h1>
    <p class="mt-2 text-sm text-muted-foreground">{m.wizard_domain_body()}</p>
    <label class="mt-6 block space-y-1.5">
      <span class="text-sm font-medium">{m.wizard_domain_label()}</span>
      <input
        class="h-11 w-full rounded-lg border bg-background px-3"
        placeholder="relay.example.com"
        inputmode="url"
        autocapitalize="off"
        bind:value={host}
        data-testid="domain-input"
      />
    </label>
    <section class="mt-6 rounded-xl border p-4" aria-live="polite" data-testid="tls-status">
      <div class="flex items-center gap-2">
        <ShieldCheck class="size-4" />
        <h2 class="text-sm font-medium">{m.wizard_tls_title()}</h2>
        {#if check}
          <Badge tone={check.ok ? 'ok' : 'warn'}>{check.ok ? m.wizard_tls_ok() : m.wizard_tls_issues()}</Badge>
        {/if}
      </div>
      {#if check}
        <p class="mt-2 text-sm text-muted-foreground">
          {check.tls === 'acme'
            ? m.wizard_tls_acme()
            : check.tls === 'proxy'
              ? m.wizard_tls_proxy()
              : m.wizard_tls_off()}
        </p>
        {#each check.problems as p (p.message)}
          <p class="mt-2 flex gap-2 text-sm"><TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />{p.message}</p>
        {/each}
      {:else if checkError}
        <p class="mt-2 text-sm text-muted-foreground">{m.wizard_tls_unknown()}</p>
      {:else}
        <p class="mt-2 text-sm text-muted-foreground">{m.common_checking()}</p>
      {/if}
      <button class="mt-3 text-xs text-primary" onclick={runCheck}>{m.wizard_tls_recheck()}</button>
    </section>
    <div class="mt-auto flex gap-2 pt-8">
      <Button variant="secondary" class="flex-1" onclick={() => go('done')}>{m.common_skip()}</Button>
      <Button class="flex-1" disabled={busy} onclick={saveDomain} data-testid="domain-save">{m.common_continue()}</Button>
    </div>
  {:else if step === 'done'}
    <div class="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check class="size-6" /></div>
    <h1 class="mt-4 text-2xl font-semibold tracking-tight">{m.wizard_done_title()}</h1>
    <p class="mt-2 text-sm text-muted-foreground">{m.wizard_done_body()}</p>
    <div class="mt-6 space-y-2">
      {#each [{ label: m.wizard_relay_url(), value: relayUrl, id: 'relay-url' }, { label: m.wizard_blossom_url(), value: blossomUrl, id: 'blossom-url' }] as u (u.id)}
        <div class="flex items-center gap-2 rounded-xl border p-3">
          <div class="min-w-0 flex-1">
            <p class="text-xs text-muted-foreground">{u.label}</p>
            <p class="truncate font-mono text-sm" data-testid={u.id}>{u.value}</p>
          </div>
          <Button size="icon" variant="ghost" aria-label={m.common_copy()} onclick={() => copy(u.value)}><Copy class="size-4" /></Button>
        </div>
      {/each}
    </div>
    <div class="mt-6 flex justify-center"><QrCode value={relayUrl} label={m.wizard_qr_label()} /></div>
    <div class="mt-6 grid gap-2">
      <Button variant="secondary" onclick={share}><Share2 class="size-4" />{m.wizard_share()}</Button>
      <Button variant="secondary" onclick={alerts} data-testid="enable-alerts">
        <Bell class="size-4" />{m.wizard_alerts()}
      </Button>
      {#if app.hasAction('experience.test-relay')}
        <Button
          variant="secondary"
          onclick={() => {
            const def = app.action('experience.test-relay');
            if (def) void flow.start(def, {});
          }}>{m.wizard_test()}</Button
        >
      {/if}
      {#if pushState && pushState !== 'enabled'}
        <p class="text-center text-xs text-muted-foreground">
          {pushState === 'denied' ? m.push_denied() : pushState === 'unsupported' ? m.push_unsupported() : m.push_unavailable()}
        </p>
      {/if}
    </div>
    <Button class="mt-8" size="lg" onclick={() => go('recovery')} data-testid="done-next">{m.common_continue()}</Button>
  {:else if step === 'recovery'}
    <h1 class="text-2xl font-semibold tracking-tight">{m.recovery_title()}</h1>
    <p class="mt-2 text-sm text-muted-foreground">{m.recovery_body()}</p>
    {#if app.recoveryCodes?.length}
      <ol class="mt-6 grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-4 font-mono text-sm" data-testid="recovery-codes">
        {#each app.recoveryCodes as c (c)}<li>{c}</li>{/each}
      </ol>
      <div class="mt-3 flex gap-2">
        <Button variant="secondary" class="flex-1" onclick={() => copy((app.recoveryCodes ?? []).join('\n'))}>
          <Copy class="size-4" />{m.common_copy()}
        </Button>
        <Button variant="secondary" class="flex-1" onclick={downloadCodes}>{m.recovery_download()}</Button>
      </div>
    {:else}
      <p class="mt-6 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{m.recovery_none_here()}</p>
    {/if}
    <label class="mt-6 flex items-center gap-3 text-sm">
      <input type="checkbox" class="size-5 accent-[var(--primary)]" bind:checked={savedCodes} data-testid="recovery-saved" />
      {m.recovery_confirm()}
    </label>
    <Button class="mt-6" size="lg" disabled={!savedCodes && !!app.recoveryCodes?.length} onclick={finish} data-testid="wizard-finish">
      {m.wizard_finish()}
    </Button>
  {/if}
</main>
