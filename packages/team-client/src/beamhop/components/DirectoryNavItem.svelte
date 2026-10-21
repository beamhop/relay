<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Primary-nav entry for the company directory; rendered only when features.directory is on. -->
<script lang="ts">
  import UsersGroup from "@assets/icons/users-group-rounded.svg?dataurl"
  import ImageIcon from "@lib/components/ImageIcon.svelte"
  import PrimaryNavItem from "@lib/components/PrimaryNavItem.svelte"
  import {beamhopConfig} from "../config"
</script>

{#if $beamhopConfig.features.directory}
  <PrimaryNavItem title="Directory" href="/directory">
    <ImageIcon alt="Directory" src={UsersGroup} size={8} />
  </PrimaryNavItem>
{/if}
