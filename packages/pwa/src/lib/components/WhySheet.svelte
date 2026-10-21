<script lang="ts">
  /** "Why?" sheet (§6.10): cause, technical details, and where to go next. */
  import Sheet from './Sheet.svelte';
  import Button from './ui/button.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { to } from '$lib/nav';
  import { m } from '$lib/paraglide/messages.js';

  let {
    why = $bindable(null),
  }: { why: { title: string; detail?: string; playbook?: string; body?: string } | null } = $props();

  let open = $state(false);
  $effect(() => {
    open = !!why;
  });
</script>

<Sheet bind:open title={why?.title ?? ''} onclose={() => (why = null)} testid="why-sheet">
  <div class="space-y-4 text-sm">
    {#if why?.body}<p>{why.body}</p>{/if}
    <p class="text-muted-foreground">{m.why_explainer()}</p>
    {#if why?.detail}
      <div class="rounded-lg bg-muted p-3">
        <p class="mb-1 text-xs font-medium text-muted-foreground">{m.why_details()}</p>
        <pre class="whitespace-pre-wrap break-all font-mono text-[11px]">{why.detail}</pre>
      </div>
    {:else if !prefs.lens}
      <p class="text-xs text-muted-foreground">{m.why_no_details()}</p>
    {/if}
    <div class="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" href={to('/help')}>{m.why_open_help()}</Button>
      {#if why?.playbook}
        <Button variant="secondary" size="sm" href={to(`/help?playbook=${why.playbook}`)}>{m.why_open_playbook()}</Button>
      {/if}
    </div>
  </div>
</Sheet>
