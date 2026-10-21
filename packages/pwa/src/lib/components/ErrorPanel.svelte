<script lang="ts">
  /** Error boundary fallback / failed load, with a "Why?" sheet (§6.10). */
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { ApiError } from '$lib/api/client';
  import Button from './ui/button.svelte';
  import WhySheet from './WhySheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { error, reset }: { error: unknown; reset?: () => void } = $props();
  let why = $state<{ title: string; detail?: string } | null>(null);

  const message = $derived(error instanceof ApiError ? error.message : m.error_generic());
  const detail = $derived(
    error instanceof ApiError ? (error.technical ?? error.code) : error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
</script>

<div class="rounded-xl border border-destructive/30 bg-destructive/5 p-4" role="alert" data-testid="error-panel">
  <div class="flex items-start gap-3">
    <TriangleAlert class="mt-0.5 size-5 shrink-0 text-destructive" />
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium">{message}</p>
      <div class="mt-3 flex gap-2">
        {#if reset}<Button size="sm" variant="secondary" onclick={reset}>{m.common_retry()}</Button>{/if}
        <Button size="sm" variant="ghost" onclick={() => (why = { title: message, detail })}>{m.common_why()}</Button>
      </div>
    </div>
  </div>
</div>

<WhySheet bind:why />
