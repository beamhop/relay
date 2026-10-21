<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Company identity screens (lazy chunk, §12.0): Company groups at
   * `/people/company` (§12.4 group mapping, §12.5 offboarding) and the
   * Company sign-in setup at `/settings/company` (drawn by the app itself;
   * this chunk only serves it when opened as a module path).
   */
  import CompanySignIn from '$lib/components/company/CompanySignIn.svelte';
  import CompanyGroups from './enterprise-identity/CompanyGroups.svelte';

  let { path = '/people/company' }: { path?: string; sub?: string } = $props();
</script>

{#if path === '/settings/company'}
  <CompanySignIn />
{:else}
  <CompanyGroups />
{/if}
