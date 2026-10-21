<script lang="ts">
  /** ⓘ sheet (§6.2): plain explanation, recommended value, and the technical lens. */
  import Info from '@lucide/svelte/icons/info';
  import type { FieldSpec } from '$lib/forms/json-schema';
  import Sheet from '../Sheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { field }: { field: FieldSpec } = $props();
  let open = $state(false);

  const recommended = $derived(
    field.default === undefined
      ? null
      : typeof field.default === 'boolean'
        ? field.default
          ? m.common_on()
          : m.common_off()
        : Array.isArray(field.default)
          ? field.default.length
            ? field.default.join(', ')
            : m.info_none()
          : String(field.default),
  );
</script>

<button
  type="button"
  class="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
  aria-label={m.info_about({ label: field.label })}
  data-info-button
  onclick={() => (open = true)}
>
  <Info class="size-3.5" />
</button>

<Sheet bind:open title={field.label} testid="info-sheet">
  <div class="space-y-4 text-sm">
    <p>{field.help ?? m.info_no_help()}</p>
    {#if recommended !== null}
      <div class="rounded-lg bg-muted p-3">
        <p class="text-xs text-muted-foreground">{m.info_recommended()}</p>
        <p class="mt-0.5 font-medium">{recommended}</p>
      </div>
    {/if}
    {#if field.min !== undefined || field.max !== undefined}
      <p class="text-xs text-muted-foreground">
        {m.info_range({ min: String(field.min ?? '—'), max: String(field.max ?? '—') })}
      </p>
    {/if}
    <div class="rounded-lg border p-3">
      <p class="text-xs font-medium text-muted-foreground">{m.lens_title()}</p>
      <p class="mt-1 break-all font-mono text-[11px]">{field.technical}</p>
    </div>
  </div>
</Sheet>
