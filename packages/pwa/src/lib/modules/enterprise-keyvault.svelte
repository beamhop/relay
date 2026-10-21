<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Settings › Company keys (lazy chunk, §12.0, §12.3). */
  import CompanyKeys from './enterprise-keyvault/CompanyKeys.svelte';

  let { path: _path = '' }: { path?: string; sub?: string } = $props();
</script>

<CompanyKeys />
