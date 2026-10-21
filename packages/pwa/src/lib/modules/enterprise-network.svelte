<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Settings › Network access (lazy chunk, §12.0, §12.10). */
  import NetworkAccess from './enterprise-network/NetworkAccess.svelte';

  let { path: _path = '' }: { path?: string; sub?: string } = $props();
</script>

<NetworkAccess />
