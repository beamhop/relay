<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Why?" button (§6.10): asks the server why something is the way it is
   * and shows the cause, options and (with the lens) technical lines.
   */
  import Sheet from './Sheet.svelte';
  import Button from './ui/button.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { flow } from '$lib/stores/actions.svelte';
  import { to } from '$lib/nav';
  import { resolveScreen } from '$lib/screens';
  import { askWhy, type WhyAnswer, type WhyOption, type WhySubject } from '$lib/why';
  import { m } from '$lib/paraglide/messages.js';

  let {
    subject,
    label,
    class: klass = '',
  }: { subject: WhySubject; label?: string; class?: string } = $props();

  let open = $state(false);
  let loading = $state(false);
  let answer = $state<WhyAnswer | null>(null);

  async function show(e: Event) {
    e.stopPropagation();
    open = true;
    loading = true;
    answer = await askWhy(subject);
    loading = false;
  }

  function href(o: WhyOption): string | null {
    if (o.playbook) return to(`/help?playbook=${encodeURIComponent(o.playbook)}`);
    if (o.screen) {
      const r = resolveScreen(o.screen, app.uiRoutes.map((u) => u.path));
      return to(r.href);
    }
    return null;
  }

  function act(o: WhyOption) {
    const def = o.actionId ? app.action(o.actionId) : undefined;
    if (!def) return;
    open = false;
    void flow.start(def, (o.input as Record<string, unknown>) ?? {}, { form: !o.input });
  }
</script>

<button
  type="button"
  class="text-xs text-muted-foreground underline-offset-2 hover:underline {klass}"
  onclick={show}
  data-testid="why-button">{label ?? m.why_button()}</button
>

<Sheet bind:open title={answer?.title ?? m.why_button()} testid="why-answer">
  <div class="space-y-4 text-sm">
    {#if loading}
      <p class="text-muted-foreground">{m.why_loading()}</p>
    {:else if !answer}
      <p class="text-muted-foreground">{m.why_unavailable()}</p>
    {:else}
      <p>{answer.cause}</p>
      {#if prefs.lens && answer.technical.length}
        <div class="rounded-lg bg-muted p-3">
          <p class="mb-1 text-xs font-medium text-muted-foreground">{m.why_details()}</p>
          <ul class="space-y-1 font-mono text-[11px] break-all">
            {#each answer.technical as line}<li>{line}</li>{/each}
          </ul>
        </div>
      {/if}
      {#if answer.options.length}
        <div class="flex flex-wrap gap-2">
          {#each answer.options as o}
            {@const h = href(o)}
            {#if h}
              <Button variant="secondary" size="sm" href={h}>{o.label}</Button>
            {:else if o.actionId && app.action(o.actionId)}
              <Button variant="secondary" size="sm" onclick={() => act(o)}>{o.label}</Button>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</Sheet>
