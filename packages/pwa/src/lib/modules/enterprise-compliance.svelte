<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Compliance screens (lazy chunk, §12.0): Settings › Compliance (§12.7) and
   * the Approvals inbox (§12.9, also reached as `/approvals/<request id>`).
   */
  import Compliance from './enterprise-compliance/Compliance.svelte';
  import Approvals from './enterprise-compliance/Approvals.svelte';

  let { path = '/settings/compliance', sub = '' }: { path?: string; sub?: string } = $props();
</script>

{#if path === '/approvals'}
  <Approvals focus={sub} />
{:else}
  <Compliance />
{/if}
