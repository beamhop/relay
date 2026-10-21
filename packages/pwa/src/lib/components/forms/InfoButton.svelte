<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * ⓘ sheet (§6.2): plain explanation, an example, the recommended value and
   * why, plus the technical lens. Nothing is shown for a field that has no
   * explanation at all.
   */
  import Info from '@lucide/svelte/icons/info';
  import type { FieldSpec } from '$lib/forms/json-schema';
  import { prefs } from '$lib/stores/prefs.svelte';
  import Sheet from '../Sheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { field }: { field: FieldSpec } = $props();
  let open = $state(false);

  function show(v: unknown): string {
    if (typeof v === 'boolean') return v ? m.common_on() : m.common_off();
    if (Array.isArray(v)) return v.length ? v.join(', ') : m.info_none();
    const label = field.options?.find((o) => o.value === v)?.label;
    return label ?? String(v);
  }

  /** The explanation, unless it only repeats the label. */
  const help = $derived(field.help && field.help !== field.label ? field.help : undefined);
  const recommended = $derived(
    field.recommended
      ? { value: show(field.recommended.value), why: field.recommended.why }
      : field.default !== undefined && (help || field.example)
        ? { value: show(field.default), why: undefined }
        : null,
  );
  const hasContent = $derived(!!help || !!field.example || !!field.recommended || (prefs.lens && !!field.technicalNote));
</script>

{#if hasContent}
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
      {#if help}<p data-testid="info-help">{help}</p>{/if}
      {#if field.example}
        <div class="rounded-lg border p-3" data-testid="info-example">
          <p class="text-xs text-muted-foreground">{m.info_example()}</p>
          <p class="mt-0.5">{field.example}</p>
        </div>
      {/if}
      {#if recommended}
        <div class="rounded-lg bg-muted p-3" data-testid="info-recommended">
          <p class="text-xs text-muted-foreground">{field.recommended ? m.info_recommended() : m.info_default()}</p>
          <p class="mt-0.5 font-medium">{recommended.value}</p>
          {#if recommended.why}<p class="mt-1 text-xs text-muted-foreground">{recommended.why}</p>{/if}
        </div>
      {/if}
      {#if field.min !== undefined || field.max !== undefined}
        <p class="text-xs text-muted-foreground">
          {m.info_range({ min: String(field.min ?? '—'), max: String(field.max ?? '—') })}
        </p>
      {/if}
      {#if prefs.lens}
        <div class="rounded-lg border p-3" data-lens>
          <p class="text-xs font-medium text-muted-foreground">{m.lens_title()}</p>
          <p class="mt-1 break-all font-mono text-[11px]">{field.technical}</p>
          {#if field.technicalNote}<p class="mt-1 text-xs">{field.technicalNote}</p>{/if}
        </div>
      {/if}
    </div>
  </Sheet>
{/if}
