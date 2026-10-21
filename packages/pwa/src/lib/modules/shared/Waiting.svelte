<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Waiting for a second admin" (two-person rule, §12.9): shown where a risky
   * change was asked for. Once approved, the requester carries it out here.
   */
  import Hourglass from '@lucide/svelte/icons/hourglass';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { type ApprovalRow, timeLeft } from './approvals.ts';
  import { requests } from './requests.svelte.ts';

  let { row, after }: { row: ApprovalRow; after?: () => void } = $props();
  const approved = $derived(row.status === 'approved');
</script>

<div
  class="flex items-start gap-2 rounded-lg border border-dashed p-2.5 text-sm"
  data-testid="waiting-approval"
  data-status={row.status}
>
  {#if approved}
    <CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />
  {:else}
    <Hourglass class="mt-0.5 size-4 shrink-0 text-warning" />
  {/if}
  <div class="min-w-0 flex-1">
    {#if approved}
      <p class="font-medium">Approved by {row.decidedByName ?? 'a second admin'}</p>
      <p class="text-xs text-muted-foreground">
        Carry it out {row.approvalExpiresAt ? timeLeft(row.approvalExpiresAt) : 'soon'}, or the approval runs out.
      </p>
    {:else}
      <p class="font-medium">Waiting for a second admin</p>
      <p class="text-xs text-muted-foreground">Another admin must approve this. The request runs out {timeLeft(row.expiresAt)}.</p>
    {/if}
    <ItemLens lines={[`two-person rule (§12.9)`, `request ${row.id || 'pending'}`, row.actionId]} />
  </div>
  {#if approved}
    <Button size="sm" onclick={() => requests.carryOut(row, after)} data-testid="carry-out">Carry out now</Button>
  {:else if row.id}
    <Button size="sm" variant="ghost" onclick={() => requests.withdraw(row).then(() => after?.())} data-testid="withdraw">Withdraw</Button>
  {/if}
</div>
