<script lang="ts">
  /** Global action runner: generated form → preview diff → apply → undo toast. */
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { flow } from '$lib/stores/actions.svelte';
  import { fieldsFromSchema } from '$lib/forms/json-schema';
  import { flatten, formDefaults, unflatten } from '$lib/forms/zod';
  import { prefs } from '$lib/stores/prefs.svelte';
  import Sheet from './Sheet.svelte';
  import DiffList from './DiffList.svelte';
  import Button from './ui/button.svelte';
  import GeneratedForm from './forms/GeneratedForm.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let open = $state(false);
  $effect(() => {
    open = !!flow.current;
  });

  const cur = $derived(flow.current);
  const fields = $derived(cur ? fieldsFromSchema(cur.action.inputSchema ?? {}) : []);
  const formId = $derived(cur ? `action-${cur.action.id}` : 'action');
</script>

<Sheet
  bind:open
  title={cur?.action.title ?? ''}
  description={cur?.action.description}
  onclose={() => flow.close()}
  testid="action-sheet"
>
  {#if cur}
    {#if prefs.lens}
      <p class="mb-3 rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground" data-lens>
        {cur.action.id} · {cur.action.permission}{cur.action.technical ? ` · ${cur.action.technical}` : ''}
        <br />$ {cur.action.cli}
      </p>
    {/if}
    {#if cur.error}
      <div class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
        <p class="font-medium">{cur.error.message}</p>
        {#each cur.error.issues ?? [] as issue (issue.path)}
          <p class="text-xs text-muted-foreground">{issue.path}: {issue.message}</p>
        {/each}
        {#if prefs.lens && cur.error.technical}<p class="mt-1 font-mono text-[11px]">{cur.error.technical}</p>{/if}
      </div>
    {/if}
    {#if cur.phase === 'form'}
      {#key cur.action.id}
        <GeneratedForm
          id={formId}
          {fields}
          initial={{ ...formDefaults(fields), ...flatten(cur.input, fields) }}
          onsubmit={(v) => flow.preview(unflatten(v, fields))}
        />
      {/key}
    {:else if cur.phase === 'running'}
      <div class="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />
        {m.common_working()}
      </div>
    {:else if cur.phase === 'preview'}
      <p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.action_what_changes()}</p>
      <DiffList diff={cur.diff} />
      {#if cur.action.undoable}
        <p class="mt-3 text-xs text-muted-foreground">{m.action_undo_hint()}</p>
      {/if}
    {:else if cur.phase === 'done' && cur.result}
      {@const out = (cur.result.output ?? {}) as { code?: string; codes?: string[]; token?: string }}
      <p class="mb-3 text-sm">{cur.result.summary}</p>
      {#if out.code || out.token || out.codes}
        <p class="mb-2 text-xs text-warning">{m.action_shown_once()}</p>
        <div class="mb-3 rounded-xl border bg-muted/40 p-4 font-mono text-sm break-all select-all" data-testid="action-secret">
          {#if out.codes}{#each out.codes as c (c)}<div>{c}</div>{/each}{:else}{out.code ?? out.token}{/if}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onclick={() => navigator.clipboard?.writeText(out.codes ? out.codes.join('\n') : (out.code ?? out.token ?? ''))}
        >{m.common_copy()}</Button>
      {/if}
      {#if prefs.lens || cur.action.readOnly}
        <pre class="max-h-[50dvh] overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px]" data-testid="action-output">{JSON.stringify(cur.result.output, null, 2)}</pre>
      {/if}
    {/if}
  {/if}

  {#snippet footer()}
    {#if cur?.phase === 'form'}
      <div class="flex gap-2">
        <Button variant="secondary" class="flex-1" onclick={() => flow.close()}>{m.common_cancel()}</Button>
        <Button class="flex-1" type="submit" form={formId} data-testid="action-continue">
          {cur.action.readOnly ? m.action_show() : m.action_review()}
        </Button>
      </div>
    {:else if cur?.phase === 'preview'}
      <div class="flex gap-2">
        <Button variant="secondary" class="flex-1" onclick={() => flow.close()}>{m.common_cancel()}</Button>
        <Button
          class="flex-1"
          variant={cur.diff.some((d) => d.kind === 'remove' || d.kind === 'warning') ? 'destructive' : 'default'}
          data-testid="action-confirm"
          onclick={() => flow.confirm()}
        >
          {m.action_apply()}
        </Button>
      </div>
    {:else if cur?.phase === 'error' || cur?.phase === 'done'}
      <Button variant="secondary" class="w-full" onclick={() => flow.close()}>{m.common_close()}</Button>
    {/if}
  {/snippet}
</Sheet>
