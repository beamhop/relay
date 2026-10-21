<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import { app } from '$lib/stores/app.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

{#if !app.online}
  <div class="flex items-center justify-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning" role="status" data-testid="offline-banner">
    <WifiOff class="size-3.5" />
    {m.offline_banner()}
  </div>
{:else if app.phase === 'ready' && !live.connected && live.items.length > 0}
  <div class="bg-muted px-3 py-1 text-center text-[11px] text-muted-foreground" role="status">{m.live_reconnecting()}</div>
{/if}
