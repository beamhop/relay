<script lang="ts">
  /**
   * A form generated from JSON-Schema field specs (§6.6): zod validation via
   * superforms (SPA mode), accessible markup via formsnap. Every field has an
   * ⓘ sheet with the plain explanation; the technical lens adds raw keys.
   */
  import { superForm, defaults } from 'sveltekit-superforms';
  import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
  import { Field, Control, Label, Description, FieldErrors } from 'formsnap';
  import type { Snippet } from 'svelte';
  import type { FieldSpec } from '$lib/forms/json-schema';
  import { formKey, leaves, zodForFields } from '$lib/forms/zod';
  import { prefs } from '$lib/stores/prefs.svelte';
  import Switch from '../ui/switch.svelte';
  import InfoButton from './InfoButton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    fields,
    initial = {},
    id = 'generated-form',
    onsubmit,
    onchange,
    footer,
  }: {
    fields: FieldSpec[];
    initial?: Record<string, unknown>;
    id?: string;
    onsubmit: (values: Record<string, unknown>) => void | Promise<void>;
    onchange?: (values: Record<string, unknown>) => void;
    footer?: Snippet;
  } = $props();

  const flat = $derived(leaves(fields));
  // svelte-ignore state_referenced_locally
  const schema = zodForFields(fields);
  // svelte-ignore state_referenced_locally
  const form = superForm(defaults(initial as never, zod4(schema)), {
    id,
    SPA: true,
    dataType: 'json',
    resetForm: false,
    validators: zod4Client(schema),
    async onUpdate({ form: f }) {
      if (f.valid) await onsubmit(f.data as Record<string, unknown>);
    },
  });
  const { form: data, enhance, errors } = form;

  $effect(() => {
    onchange?.({ ...($data as Record<string, unknown>) });
  });

  function listText(v: unknown): string {
    return Array.isArray(v) ? v.join(', ') : '';
  }
  function setList(f: FieldSpec, text: string) {
    const parts = text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    ($data as Record<string, unknown>)[formKey(f)] = f.itemKind === 'number' ? parts.map(Number) : parts;
  }
  function setNumber(f: FieldSpec, raw: string) {
    ($data as Record<string, unknown>)[formKey(f)] = raw === '' ? (f.nullable ? null : undefined) : Number(raw);
  }
</script>

<form method="POST" use:enhance {id} class="space-y-1" novalidate>
  {#each flat as f (formKey(f))}
    {@const key = formKey(f)}
    <Field {form} name={key as never}>
      <div class="py-3" data-setting-field={f.path.join('.')}>
        <Control>
          {#snippet children({ props })}
            {#if f.kind === 'boolean'}
              <div class="flex items-center gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1">
                    <Label class="text-sm font-medium">{f.label}</Label>
                    <InfoButton field={f} />
                  </div>
                  {#if prefs.lens}<p class="font-mono text-[11px] text-muted-foreground" data-lens>{f.technical}</p>{/if}
                </div>
                <Switch
                  {...props}
                  data-setting-input
                  checked={!!($data as Record<string, unknown>)[key]}
                  onCheckedChange={(v) => (($data as Record<string, unknown>)[key] = v)}
                />
              </div>
            {:else}
              <div class="mb-1.5 flex items-center gap-1">
                <Label class="text-sm font-medium">{f.label}</Label>
                <InfoButton field={f} />
              </div>
              {#if f.kind === 'enum'}
                <select
                  {...props}
                  data-setting-input
                  class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                  bind:value={($data as Record<string, unknown>)[key]}
                >
                  {#if !f.required}<option value={undefined}>{m.form_default_option()}</option>{/if}
                  {#each f.options ?? [] as o (o.value)}
                    <option value={o.value}>{o.label}{prefs.lens ? ` (${o.value})` : ''}</option>
                  {/each}
                </select>
              {:else if f.kind === 'integer' || f.kind === 'number'}
                <input
                  {...props}
                  data-setting-input
                  type="number"
                  inputmode={f.kind === 'integer' ? 'numeric' : 'decimal'}
                  min={f.min}
                  max={f.max}
                  step={f.kind === 'integer' ? 1 : 'any'}
                  class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                  value={($data as Record<string, unknown>)[key] ?? ''}
                  oninput={(e) => setNumber(f, e.currentTarget.value)}
                  placeholder={f.default !== undefined ? String(f.default) : ''}
                />
              {:else if f.kind === 'textarea'}
                <textarea
                  {...props}
                  data-setting-input
                  rows="3"
                  class="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                  bind:value={($data as Record<string, unknown>)[key]}
                ></textarea>
              {:else if f.kind === 'list'}
                <input
                  {...props}
                  data-setting-input
                  class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                  value={listText(($data as Record<string, unknown>)[key])}
                  onchange={(e) => setList(f, e.currentTarget.value)}
                  placeholder={m.form_list_placeholder()}
                />
              {:else if f.kind === 'json'}
                <textarea
                  {...props}
                  data-setting-input
                  rows="4"
                  class="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs"
                  value={JSON.stringify(($data as Record<string, unknown>)[key] ?? null, null, 2)}
                  onchange={(e) => {
                    try {
                      ($data as Record<string, unknown>)[key] = JSON.parse(e.currentTarget.value);
                    } catch {
                      /* keep the previous value until it parses */
                    }
                  }}
                ></textarea>
              {:else}
                <input
                  {...props}
                  data-setting-input
                  type={f.secret ? 'password' : f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : 'text'}
                  autocomplete="off"
                  class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                  bind:value={($data as Record<string, unknown>)[key]}
                  placeholder={f.default !== undefined ? String(f.default) : ''}
                />
              {/if}
              {#if prefs.lens}<p class="mt-1 font-mono text-[11px] text-muted-foreground" data-lens>{f.technical}</p>{/if}
            {/if}
          {/snippet}
        </Control>
        {#if f.help && f.help !== f.label && f.kind !== 'boolean'}
          <Description class="mt-1 text-xs text-muted-foreground">{f.help}</Description>
        {/if}
        <FieldErrors class="mt-1 text-xs text-destructive" />
        {#if ($errors as Record<string, unknown>)[key]}<span class="sr-only">{m.form_has_error()}</span>{/if}
      </div>
    </Field>
  {/each}
  {@render footer?.()}
</form>
