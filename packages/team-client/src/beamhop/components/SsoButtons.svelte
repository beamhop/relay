<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- "Sign in with <company IdP>" buttons (config.json `sso.providers`), shown when features.sso. -->
<script lang="ts">
  import {base} from "$app/paths"
  import {beamhopConfig} from "../config"

  /** Come back to the app after the IdP; TeamSessionGate then finishes the sign-in. */
  const startHref = (startUrl: string) => {
    const url = new URL(startUrl, location.origin)

    url.searchParams.set("returnTo", `${base}/`)

    return url.pathname + url.search
  }
</script>

{#if $beamhopConfig.features.sso && $beamhopConfig.sso.providers.length > 0}
  <div class="flex flex-col gap-2" data-testid="beamhop-sso">
    {#each $beamhopConfig.sso.providers as provider (provider.id)}
      <a class="button button-primary" href={startHref(provider.startUrl)} data-sveltekit-reload>
        Sign in with {provider.label}
      </a>
    {/each}
  </div>
{/if}
