<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- DM escrow disclosure banner (PLAN §12.8), shown when config.json has features.escrowNotice. -->
<script lang="ts">
  import {ESCROW_NOTICE_TEXT, dismissEscrowNotice, showEscrowNotice} from "../features/escrow"
</script>

{#if $showEscrowNotice}
  <div
    role="status"
    class="fixed inset-x-0 bottom-0 z-[60] flex items-center justify-center gap-3 border-t border-line bg-surface-more px-4 py-2 text-sm text-content-muted"
    style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom));">
    <span>{ESCROW_NOTICE_TEXT}</span>
    <button type="button" class="underline" onclick={dismissEscrowNotice}>Got it</button>
  </div>
{/if}
