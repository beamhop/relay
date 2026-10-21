<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Settings › Company sign-in (enterprise identity module). */
  import CompanySignIn from '$lib/components/company/CompanySignIn.svelte';
  import { to } from '$lib/nav';
  import { m } from '$lib/paraglide/messages.js';
</script>

<svelte:head><title>{m.company_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.company_title()}</h1>
<p class="mt-1 text-sm text-muted-foreground">{m.company_intro()}</p>
<div class="mt-4 md:max-w-2xl"><CompanySignIn /></div>
