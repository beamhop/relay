<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Settings › Backups and restore (lazy chunk named by the lifecycle module's `/ui` route). */
  import Backups from './lifecycle-backups/Backups.svelte';

  let { path: _path = '' }: { path?: string; sub?: string } = $props();
</script>

<Backups />
