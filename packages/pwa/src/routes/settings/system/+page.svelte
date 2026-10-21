<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Settings → Updates & health (§14, §6.7, §6.11): one-tap update with rollback, doctor, resource advice. */
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/app.svelte';
  import { to } from '$lib/nav';
  import UpdateCard from '$lib/components/system/UpdateCard.svelte';
  import DoctorList from '$lib/components/system/DoctorList.svelte';
  import AdvisorCards from '$lib/components/system/AdvisorCards.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const hasUpdates = $derived(app.hasAction('system.update-check'));
  const hasDoctor = $derived(app.hasAction('system.doctor'));
  const hasAdvisor = $derived(app.hasAction('system.advisor'));
  /** Runtime when this server has no system actions (Cloudflare Workers bundle). */
  let runtime = $state<string | null>(null);

  onMount(async () => {
    if (hasUpdates) return;
    const nodes = await app.api.nodes().catch(() => []);
    runtime = nodes[0]?.runtime ?? null;
  });
</script>

<svelte:head><title>{m.system_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.system_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.system_intro()}</p>

<div class="mt-4 space-y-4 md:max-w-2xl" data-testid="system-screen">
  {#if hasUpdates}
    <UpdateCard />
  {:else}
    <section class="rounded-xl border p-4" data-testid="update-card">
      <h2 class="text-sm font-medium">{m.system_update_title()}</h2>
      <p class="mt-1 text-sm text-muted-foreground" data-testid="update-blocked">
        {runtime === 'cloudflare' ? m.system_cloudflare_how() : m.system_update_unavailable()}
      </p>
    </section>
  {/if}
  {#if hasDoctor}<DoctorList />{/if}
  {#if hasAdvisor}<AdvisorCards />{/if}
</div>
