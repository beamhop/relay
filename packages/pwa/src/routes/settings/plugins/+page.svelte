<script lang="ts">
  /** Plugins: placeholder until the plugin SDK ships its admin screens. */
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import { to } from '$lib/nav';
  import { m } from '$lib/paraglide/messages.js';
</script>

<svelte:head><title>{m.settings_plugins_title()} · {m.app_name()}</title></svelte:head>

<a href={to('/settings')} class="text-sm text-muted-foreground">← {m.nav_settings()}</a>
<h1 class="mt-2 text-xl font-semibold tracking-tight">{m.settings_plugins_title()}</h1>
<div class="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
  <Puzzle class="size-8 text-muted-foreground" />
  <p class="text-sm text-muted-foreground">{m.plugins_soon()}</p>
</div>
