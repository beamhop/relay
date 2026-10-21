<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** One assistant suggestion: the standard plain-language diff + Approve (§6.3, §6.5). */
  import Lightbulb from '@lucide/svelte/icons/lightbulb';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import type { ProposalCard } from '$lib/assistant';
  import { prefs } from '$lib/stores/prefs.svelte';
  import DiffList from '../DiffList.svelte';
  import Button from '../ui/button.svelte';
  import Badge from '../ui/badge.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { card, onapprove, ondismiss }: { card: ProposalCard; onapprove: () => void; ondismiss: () => void } = $props();
  const p = $derived(card.proposal);
  const risky = $derived(p.diffLines.some((d) => d.kind === 'remove' || d.kind === 'warning'));
</script>

<article class="rounded-xl border bg-background p-3" data-testid="assistant-proposal" data-state={card.state}>
  <div class="mb-2 flex items-start gap-2">
    <Lightbulb class="mt-0.5 size-4 shrink-0 text-primary" />
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium leading-snug">{p.title}</p>
      <p class="text-xs text-muted-foreground">{m.assistant_proposal_hint()}</p>
    </div>
    {#if p.sensitive}<Badge tone="warn">{m.assistant_sensitive()}</Badge>{/if}
  </div>
  {#if prefs.lens}
    <p class="mb-2 break-all rounded-md bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground" data-lens>
      {p.approve.method} {p.approve.path} · {JSON.stringify(p.approve.body)}
    </p>
  {/if}
  <DiffList diff={p.diffLines} />
  {#if card.state === 'applied'}
    <p class="mt-3 flex items-center gap-2 text-sm text-success" data-testid="proposal-applied"><CircleCheck class="size-4" />{card.note}</p>
  {:else if card.state === 'dismissed'}
    <p class="mt-3 text-xs text-muted-foreground">{card.note ?? m.assistant_dismissed()}</p>
  {:else}
    {#if card.state === 'failed' && card.note}<p class="mt-3 text-sm text-destructive" role="alert">{card.note}</p>{/if}
    <div class="mt-3 flex gap-2">
      <Button size="sm" variant="secondary" class="flex-1" onclick={ondismiss} disabled={card.state === 'applying'}>{m.assistant_dismiss()}</Button>
      <Button
        size="sm"
        class="flex-1"
        variant={risky ? 'destructive' : 'default'}
        onclick={onapprove}
        disabled={card.state === 'applying'}
        data-testid="proposal-approve"
      >
        {card.state === 'applying' ? m.common_working() : m.assistant_approve()}
      </Button>
    </div>
  {/if}
</article>
