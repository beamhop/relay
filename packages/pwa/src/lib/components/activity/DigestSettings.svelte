<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Digest (§6.9): how often the summary is sent and whether it includes a
   * learning tip, plus "Send a digest now". Saves through the standard safe
   * change flow (plain diff → apply → undo), like the Settings screens.
   */
  import { onMount } from 'svelte';
  import Mail from '@lucide/svelte/icons/mail';
  import { app } from '$lib/stores/app.svelte';
  import { configFlow } from '$lib/stores/config.svelte';
  import { runNow } from '$lib/stores/actions.svelte';
  import { to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import Sheet from '../Sheet.svelte';
  import Button from '../ui/button.svelte';
  import Switch from '../ui/switch.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type Freq = 'off' | 'daily' | 'weekly';
  let digest = $state<Freq | null>(null);
  let tips = $state(true);
  let open = $state(false);
  let draft = $state<Freq>('daily');
  let draftTips = $state(true);
  let sending = $state(false);

  const canEdit = $derived(app.can('config.write', false));

  async function load() {
    try {
      const { config } = await app.api.config();
      digest = (config.alerts?.digest as Freq | undefined) ?? 'daily';
      const mod = (config.modules as Record<string, { digestTips?: boolean }> | undefined)?.alerts;
      tips = mod?.digestTips ?? true;
    } catch {
      digest = null;
    }
  }
  onMount(load);

  function edit() {
    draft = digest ?? 'daily';
    draftTips = tips;
    open = true;
  }

  async function save() {
    const ok = await configFlow.propose(
      {
        merge: { alerts: { digest: draft }, modules: { alerts: { digestTips: draftTips } } },
        summary: m.act_digest_summary(),
      },
      { relay: false, onApplied: () => void load() },
    );
    if (ok) open = false;
  }

  async function sendNow() {
    sending = true;
    await runNow('alerts.send-digest', {});
    sending = false;
  }

  const freqText: Record<Freq, () => string> = {
    off: () => m.act_digest_off(),
    daily: () => m.act_digest_daily(),
    weekly: () => m.act_digest_weekly(),
  };
</script>

{#if digest !== null}
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-xl border p-3 text-left text-sm hover:bg-muted/50"
    onclick={edit}
    disabled={!canEdit}
    data-testid="digest-row"
  >
    <Mail class="size-4 shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1">
      <span class="block">{m.act_digest_title()}</span>
      <span class="block text-xs text-muted-foreground" data-testid="digest-state">
        {freqText[digest]()}{digest !== 'off' ? ` · ${tips ? m.act_digest_tips_on() : m.act_digest_tips_off()}` : ''}
      </span>
    </span>
  </button>
{/if}

<Sheet bind:open title={m.act_digest_title()} description={m.act_digest_desc()} testid="digest-sheet">
  <div class="space-y-5 text-sm">
    <div role="radiogroup" aria-label={m.act_digest_title()} class="grid grid-cols-3 gap-2">
      {#each ['off', 'daily', 'weekly'] as const as f (f)}
        <button
          type="button"
          role="radio"
          aria-checked={draft === f}
          class={cn('rounded-lg border px-3 py-2', draft === f ? 'border-foreground bg-muted font-medium' : 'text-muted-foreground')}
          onclick={() => (draft = f)}
          data-testid={`digest-${f}`}
        >
          {freqText[f]()}
        </button>
      {/each}
    </div>
    <label class="flex items-center gap-3">
      <span class="flex-1">
        <span class="block">{m.act_digest_tips()}</span>
        <span class="block text-xs text-muted-foreground">{m.act_digest_tips_desc()}</span>
      </span>
      <Switch bind:checked={draftTips} label={m.act_digest_tips()} disabled={draft === 'off'} data-testid="digest-tips" />
    </label>
    {#if app.hasAction('alerts.send-digest')}
      <Button variant="secondary" size="sm" disabled={sending} onclick={sendNow} data-testid="digest-send">{m.act_digest_send()}</Button>
    {/if}
    <p class="text-xs text-muted-foreground"><a class="text-primary" href={to('/settings/alerts')}>{m.alerts_configure()}</a></p>
  </div>
  {#snippet footer()}
    <Button class="w-full" disabled={configFlow.busy} onclick={save} data-testid="digest-save">{m.common_save()}</Button>
  {/snippet}
</Sheet>
