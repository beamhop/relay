<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Consent line with the workspace's own legal links (config.json `links`); hidden when none. -->
<script lang="ts">
  import Link from "@lib/components/Link.svelte"
  import {legalLinks} from "../features/links"

  type Props = {
    name: string
    about?: string
  }

  const {name, about = ""}: Props = $props()
</script>

{#if $legalLinks.terms || $legalLinks.privacy}
  <p class="text-center text-xs opacity-75" data-testid="beamhop-legal-links">
    By using
    {#if about}<Link external class="link" href={about}>{name}</Link>{:else}{name}{/if}, you consent
    to our
    {#if $legalLinks.terms}
      <Link external class="link" href={$legalLinks.terms}>Terms of Service</Link>
    {/if}
    {#if $legalLinks.terms && $legalLinks.privacy}and{/if}
    {#if $legalLinks.privacy}
      <Link external class="link" href={$legalLinks.privacy}>Privacy Policy</Link>{/if}.
  </p>
{/if}
