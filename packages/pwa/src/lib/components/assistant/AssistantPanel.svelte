<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Chat with the relay (§6.5, §6.9): bottom sheet on phones, side panel on
   * desktop. Answers stream in; tools the assistant used are listed in plain
   * words (raw names and inputs under the technical lens). Suggestions show
   * the standard diff and change nothing until the admin taps Approve.
   */
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
  import Square from '@lucide/svelte/icons/square';
  import Search from '@lucide/svelte/icons/search';
  import PowerOff from '@lucide/svelte/icons/power-off';
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { app } from '$lib/stores/app.svelte';
  import { assistant } from '$lib/stores/assistant.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { screenName } from '$lib/assistant';
  import { local, to } from '$lib/nav';
  import Sheet from '../Sheet.svelte';
  import Button from '../ui/button.svelte';
  import ProposalCard from './ProposalCard.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false), onpalette }: { open?: boolean; onpalette?: () => void } = $props();

  let draft = $state('');
  let input: HTMLTextAreaElement | undefined = $state();
  let scroller: HTMLElement | undefined = $state();

  const off = $derived(!assistant.installed || !!assistant.offMessage);
  const canTurnOn = $derived(app.can('config.write', false));
  const suggestions = $derived([m.assistant_suggest_health(), m.assistant_suggest_screen(), m.assistant_suggest_change()]);

  function context() {
    const ctx: { screen: string; relayId?: string; selection?: unknown; lens: 'simple' | 'technical' } = {
      screen: screenName(local(page.url.pathname), page.url.search),
      lens: prefs.lens ? 'technical' : 'simple',
    };
    if (app.relayId) ctx.relayId = app.relayId;
    if (assistant.selection !== undefined) ctx.selection = $state.snapshot(assistant.selection);
    return ctx;
  }

  async function send(text = draft) {
    if (!text.trim() || assistant.busy) return;
    draft = '';
    const p = assistant.ask(text, context());
    await tick();
    scrollDown();
    await p;
    scrollDown();
  }

  function scrollDown() {
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  // Keep the newest text in view while it streams.
  $effect(() => {
    const last = assistant.turns[assistant.turns.length - 1];
    void last?.text.length;
    void last?.proposals.length;
    if (last?.pending) scrollDown();
  });

  $effect(() => {
    if (open && input && !off) void tick().then(() => input?.focus({ preventScroll: true }));
  });

  function palette() {
    open = false;
    onpalette?.();
  }
</script>

<Sheet bind:open title={m.assistant_title()} description={off ? undefined : m.assistant_desc()} testid="assistant">
  {#if off}
    <div class="flex flex-col items-center gap-3 py-8 text-center" data-testid="assistant-off">
      <span class="flex size-12 items-center justify-center rounded-full bg-muted"><PowerOff class="size-5 text-muted-foreground" /></span>
      <p class="font-medium">{m.assistant_off_title()}</p>
      <p class="max-w-xs text-sm text-muted-foreground">{canTurnOn ? m.assistant_off_body() : m.assistant_off_body_ask()}</p>
      {#if prefs.lens}<p class="font-mono text-[11px] text-muted-foreground" data-lens>{assistant.offMessage ?? 'ai module not registered (no ai.* actions)'} · config ai.enabled</p>{/if}
      <div class="mt-2 flex flex-wrap justify-center gap-2">
        {#if canTurnOn}
          <Button size="sm" href={to('/settings/ai')} onclick={() => (open = false)} data-testid="assistant-turn-on">{m.assistant_off_cta()}</Button>
        {/if}
        <Button size="sm" variant="secondary" onclick={palette}><Search class="size-4" />{m.palette_search()}</Button>
      </div>
    </div>
  {:else}
    <div bind:this={scroller} class="space-y-4 pb-2" data-testid="assistant-transcript" aria-live="polite">
      {#if assistant.turns.length === 0}
        <div class="flex flex-col items-start gap-2 pt-2">
          <p class="flex items-center gap-2 text-sm text-muted-foreground"><Sparkles class="size-4 text-primary" />{m.assistant_empty()}</p>
          {#each suggestions as s (s)}
            <button type="button" class="rounded-full border px-3 py-1.5 text-left text-sm hover:bg-muted" onclick={() => send(s)}>{s}</button>
          {/each}
        </div>
      {/if}
      {#each assistant.turns as turn (turn.id)}
        {#if turn.role === 'user'}
          <div class="flex justify-end">
            <p class="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground" data-testid="assistant-question">{turn.text}</p>
          </div>
        {:else}
          <div class="space-y-2" data-testid="assistant-answer" data-pending={turn.pending}>
            {#if turn.tools.length}
              <ul class="space-y-1" aria-label={m.assistant_tools()}>
                {#each turn.tools as step (step.id)}
                  <li class="flex items-start gap-2 text-xs text-muted-foreground" data-testid="assistant-tool">
                    {#if step.ok === undefined}
                      <LoaderCircle class="mt-0.5 size-3.5 shrink-0 animate-spin" />
                    {:else if step.ok}
                      <Check class="mt-0.5 size-3.5 shrink-0 text-success" />
                    {:else}
                      <CircleAlert class="mt-0.5 size-3.5 shrink-0 text-warning" />
                    {/if}
                    <div class="min-w-0">
                      <p>{step.summary ?? m.assistant_tool_running()}</p>
                      {#if prefs.lens}
                        <p class="break-all font-mono text-[10px]" data-lens>{step.name}({JSON.stringify(step.args ?? {})})</p>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if turn.text}
              <p class="whitespace-pre-wrap text-sm leading-relaxed" data-testid="assistant-text">{turn.text}</p>
            {:else if turn.pending}
              <p class="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />{m.assistant_thinking()}</p>
            {/if}
            {#each turn.proposals as card (card.proposal.id)}
              <ProposalCard
                {card}
                onapprove={() => assistant.approve(turn.id, card.proposal.id)}
                ondismiss={() => assistant.dismiss(turn.id, card.proposal.id)}
              />
            {/each}
            {#if turn.error}
              <p class="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm" role="alert" data-testid="assistant-error">
                {turn.error.message}
                {#if prefs.lens}<span class="block font-mono text-[11px] text-muted-foreground" data-lens>{turn.error.code}</span>{/if}
              </p>
            {/if}
            {#if turn.stopped && turn.stopped !== 'aborted' && prefs.lens}
              <p class="font-mono text-[11px] text-muted-foreground" data-lens>stopped: {turn.stopped}</p>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    {#if !off}
      <form
        class="flex items-end gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          bind:this={input}
          bind:value={draft}
          {onkeydown}
          rows="1"
          maxlength="4000"
          placeholder={m.assistant_placeholder()}
          aria-label={m.assistant_placeholder()}
          class="max-h-32 min-h-10 flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm"
          data-testid="assistant-input"
        ></textarea>
        {#if assistant.busy}
          <Button type="button" size="icon" variant="secondary" aria-label={m.assistant_stop()} onclick={() => assistant.stop()}><Square class="size-4" /></Button>
        {:else}
          <Button type="submit" size="icon" aria-label={m.assistant_send()} disabled={!draft.trim()} data-testid="assistant-send"><SendHorizontal class="size-4" /></Button>
        {/if}
      </form>
      <div class="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{m.assistant_never_applies()}</span>
        <button type="button" class="hover:text-foreground" onclick={palette}>{m.assistant_open_palette()}</button>
      </div>
    {/if}
  {/snippet}
</Sheet>
