<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Write a plugin from a description (§6.5.4): one plain text box →
   * `ai.generate-plugin` (writes the plugin and its tests, runs the tests in
   * the sandbox, installs it TURNED OFF) → review: what it does, test results,
   * what it may access, the code behind the technical lens. Turning it on is
   * the normal preview → apply → undo flow; it is never turned on by itself.
   */
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import Copy from '@lucide/svelte/icons/copy';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { haptic } from '$lib/haptics';
  import Sheet from '$lib/components/Sheet.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import {
    type GeneratePluginOutput,
    type PluginPermission,
    type WriterEvent,
    type WriterState,
    MAX_DESCRIPTION,
    canGenerate,
    declaredPermissions,
    enableBlock,
    initialState,
    isCurrentRun,
    markAi,
    needsApproval,
    pluginHooks,
    pluginInfo,
    reduce,
    stepsLine,
    testCases,
    testCounts,
  } from './writer';

  let {
    open = $bindable(false),
    onchanged,
    ondiscard,
  }: {
    open?: boolean;
    /** The installed plugin list changed (installed, turned on, undone). */
    onchanged?: () => void;
    /** Remove an installed draft (with an undo toast). */
    ondiscard?: (id: string, name: string) => void;
  } = $props();

  let st = $state<WriterState>(initialState());
  let whyOpen = $state(false);
  let elapsed = $state(0);
  /** Id of the plugin whose declared access was allowed in this sheet. */
  let allowedId = $state<string | null>(null);

  const send = (e: WriterEvent) => {
    st = reduce(st, e);
  };

  const EXAMPLES = [m.plugin_writer_example_links(), m.plugin_writer_example_nsfw(), m.plugin_writer_example_night()];

  const PERMISSION_TEXT: Record<PluginPermission, () => string> = {
    'read-events': () => m.plugin_writer_perm_read(),
    'write-events': () => m.plugin_writer_perm_write(),
    network: () => m.plugin_writer_perm_network(),
    docs: () => m.plugin_writer_perm_docs(),
  };

  $effect(() => {
    if (st.phase !== 'generating') return;
    const started = st.startedAt;
    elapsed = 0;
    const t = setInterval(() => (elapsed = Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  });

  async function generate() {
    const def = app.action('ai.generate-plugin');
    if (!def) return;
    send({ type: 'generate', now: Date.now() });
    if (st.phase !== 'generating') return;
    const runId = st.runId;
    try {
      const r = await app.api.run<GeneratePluginOutput>(def.id, { description: st.description }, def.scope);
      if (!isCurrentRun(st, runId)) {
        // Cancelled while it was running: take the installed draft away again.
        if (r.output?.installed && r.undo) await app.api.undo(r.undo.token).catch(() => undefined);
        onchanged?.();
        return;
      }
      if (r.output.installed) markAi(r.output.id);
      send({ type: 'success', runId, output: r.output });
      haptic((st as WriterState).phase === 'result' ? 'success' : 'warning');
      if (!open) toasts.show({ message: m.plugin_writer_ready(), kind: 'info' });
      onchanged?.();
    } catch (err) {
      if (!isCurrentRun(st, runId)) return;
      send({ type: 'error', runId, error: asApiError(err).message });
      haptic('warning');
    }
  }

  function enable() {
    if (st.phase !== 'result') return;
    const def = app.action('plugins.enable');
    if (!def || enableBlock(st.output)) return;
    void flow.start(def, { id: st.output.id }, {
      onDone: () => {
        send({ type: 'enabled' });
        onchanged?.();
      },
      onUndo: () => {
        send({ type: 'enable-undone' });
        onchanged?.();
      },
    });
  }

  /** Allow the access the plugin declares (owner; preview lists each permission in plain words). */
  function allow() {
    if (st.phase !== 'result' && st.phase !== 'enabled') return;
    const def = app.action('plugins.grant-permissions');
    const o = st.output;
    if (!def || !needsApproval(o)) return;
    void flow.start(def, { id: o.id, permissions: declaredPermissions(o) }, {
      onDone: () => {
        allowedId = o.id;
        onchanged?.();
      },
      onUndo: () => {
        allowedId = null;
        onchanged?.();
      },
    });
  }

  /** Throw the draft away: installed drafts are removed after the undo window. */
  function discard(thenRetry = false) {
    if (st.phase !== 'result') return;
    const o = st.output;
    if (o.installed) ondiscard?.(o.id, info?.name ?? o.id);
    send({ type: 'discarded' });
    if (thenRetry) send({ type: 'retry' });
    else {
      open = false;
      send({ type: 'reset' });
    }
  }

  function retry() {
    if (st.phase === 'result') discard(true);
    else send({ type: 'retry' });
  }

  function finish() {
    open = false;
    send({ type: 'reset' });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show({ message: m.plugin_writer_copied(), kind: 'info' });
    } catch {
      toasts.error(m.plugin_writer_copy_failed());
    }
  }

  const output = $derived(st.phase === 'result' || st.phase === 'enabled' ? st.output : null);
  const info = $derived(output ? pluginInfo(output) : null);
  const cases = $derived(output ? testCases(output) : []);
  const counts = $derived(output ? testCounts(output) : { passed: 0, failed: 0 });
  const perms = $derived(output ? declaredPermissions(output) : []);
  const allowed = $derived(!!output && allowedId === output.id);
  const block = $derived(output ? enableBlock(output) : null);
  const blockText = $derived(
    block === 'tests-failed'
      ? m.plugin_writer_block_tests()
      : block === 'not-tested'
        ? m.plugin_writer_block_untested()
        : block === 'not-installed'
          ? m.plugin_writer_block_not_installed()
          : '',
  );
</script>

<Sheet bind:open title={m.plugin_writer_title()} testid="plugin-writer">
  <div class="space-y-4 text-sm">
    {#if st.phase === 'idle' || st.phase === 'failed'}
      {#if st.phase === 'failed'}
        <div class="rounded-lg border border-destructive/40 bg-destructive/5 p-3" role="alert" data-testid="plugin-writer-failed">
          <p class="font-medium">{m.plugin_writer_failed_title()}</p>
          <p class="mt-1 text-muted-foreground">{st.error}</p>
          {#if st.output?.problems.length}
            <div class="mt-2"><ItemLens lines={st.output.problems} /></div>
          {/if}
        </div>
      {/if}
      <label class="block">
        <span class="mb-1 block text-sm font-medium">{m.plugin_writer_label()}</span>
        <textarea
          class="h-36 w-full rounded-lg border bg-background p-3 text-sm"
          value={st.description}
          oninput={(e) => send({ type: 'edit', description: e.currentTarget.value })}
          maxlength={MAX_DESCRIPTION}
          placeholder={m.plugin_writer_placeholder()}
          data-testid="plugin-writer-description"
        ></textarea>
      </label>
      <div>
        <p class="mb-1.5 text-xs text-muted-foreground">{m.plugin_writer_examples()}</p>
        <div class="flex flex-wrap gap-2">
          {#each EXAMPLES as ex}
            <button
              type="button"
              class="rounded-full border px-3 py-1.5 text-left text-xs hover:bg-muted"
              onclick={() => send({ type: 'edit', description: ex })}
              data-testid="plugin-writer-example">{ex}</button
            >
          {/each}
        </div>
      </div>
      <p class="text-xs text-muted-foreground">{m.plugin_writer_safe_note()}</p>
    {:else if st.phase === 'generating'}
      <div class="space-y-3 py-6 text-center" role="status" aria-live="polite" data-testid="plugin-writer-generating">
        <Sparkles class="mx-auto size-8 animate-pulse text-primary" />
        <p class="font-medium">{m.plugin_writer_generating()}</p>
        <p class="text-xs text-muted-foreground">{m.plugin_writer_generating_hint()}</p>
        <div class="mx-auto h-1.5 w-48 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div class="h-full w-1/3 animate-[writer-progress_1.4s_ease-in-out_infinite] rounded-full bg-primary"></div>
        </div>
        {#if elapsed >= 3}<p class="text-xs tabular-nums text-muted-foreground">{m.plugin_writer_elapsed({ seconds: elapsed })}</p>{/if}
        <p class="mx-auto max-w-sm text-xs text-muted-foreground italic">“{st.description}”</p>
      </div>
    {:else if output}
      {#if st.phase === 'enabled'}
        <p class="rounded-lg bg-success/10 p-3 text-success" data-testid="plugin-writer-enabled">{m.plugin_writer_enabled()}</p>
      {:else if output.installed}
        <p class="rounded-lg bg-primary/10 p-3 text-primary" data-testid="plugin-writer-installed">{m.plugin_writer_installed_off()}</p>
      {:else}
        <p class="rounded-lg bg-warning/10 p-3 text-warning" data-testid="plugin-writer-not-installed">{output.note}</p>
      {/if}

      <section>
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.plugin_writer_what()}</h3>
        <p class="mt-1 font-medium" data-testid="plugin-writer-name">{info?.name ?? output.id}</p>
        <p class="mt-0.5" data-testid="plugin-writer-summary">{info?.summary ?? st.description}</p>
        {#if info?.summary}<p class="mt-1 text-xs text-muted-foreground">{m.plugin_writer_you_asked({ text: st.description })}</p>{/if}
      </section>

      <section data-testid="plugin-writer-tests">
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.plugin_writer_tests()}</h3>
        {#if !output.tested}
          <p class="mt-1 text-muted-foreground">{m.plugin_writer_tests_none()}</p>
        {:else}
          <p class="mt-1" data-testid="plugin-writer-test-counts">
            {counts.failed ? m.plugin_writer_tests_some_failed({ passed: counts.passed, failed: counts.failed }) : m.plugin_writer_tests_all_passed({ passed: counts.passed })}
          </p>
        {/if}
        {#if cases.length}
          <ul class="mt-2 space-y-1">
            {#each cases as c}
              <li data-testid="plugin-writer-test" data-ok={c.ok}>
                {#if c.ok === false && c.detail}
                  <details class="rounded-md bg-destructive/5 px-2 py-1">
                    <summary class="flex cursor-pointer items-start gap-2">
                      <CircleX class="mt-0.5 size-4 shrink-0 text-destructive" /><span>{c.name}</span>
                    </summary>
                    <pre class="mt-1 overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">{c.detail}</pre>
                  </details>
                {:else}
                  <div class="flex items-start gap-2 px-2 py-1">
                    {#if c.ok === true}<CircleCheck class="mt-0.5 size-4 shrink-0 text-success" />
                    {:else if c.ok === false}<CircleX class="mt-0.5 size-4 shrink-0 text-destructive" />
                    {:else}<CircleHelp class="mt-0.5 size-4 shrink-0 text-muted-foreground" />{/if}
                    <span>{c.name}</span>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if output.testResult?.output && !output.testResult.ok}
          <div class="mt-2"><ItemLens lines={[output.testResult.output]} /></div>
        {/if}
      </section>

      <section>
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.plugin_writer_access()}</h3>
        {#if perms.length === 0}
          <p class="mt-1" data-testid="plugin-writer-perms">{m.plugin_writer_perm_none()}</p>
        {:else}
          <ul class="mt-1 list-disc space-y-0.5 pl-5" data-testid="plugin-writer-perms">
            {#each perms as p}<li>{PERMISSION_TEXT[p]()}</li>{/each}
          </ul>
          {#if allowed}
            <p class="mt-1 text-xs text-success" data-testid="plugin-writer-allowed">{m.plugin_writer_allowed()}</p>
          {:else}
            <p class="mt-1 text-xs text-muted-foreground">{m.plugin_writer_perm_approval()}</p>
            {#if needsApproval(output)}
              {#if app.hasAction('plugins.grant-permissions')}
                <Button size="sm" variant="secondary" class="mt-2" onclick={allow} data-testid="plugin-writer-allow">{m.plugin_writer_allow()}</Button>
              {:else}
                <p class="mt-1 text-xs text-muted-foreground" data-testid="plugin-writer-allow-owner">{m.plugin_writer_allow_owner()}</p>
              {/if}
            {/if}
          {/if}
        {/if}
      </section>

      <section data-testid="plugin-writer-code">
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.plugin_writer_code()}</h3>
        <div class="mt-1">
          <ItemLens lines={[`id ${output.id}`, `hooks: ${pluginHooks(output.code).join(', ') || '—'}`, `permissions: ${perms.join(', ') || 'none'}${allowed ? ' (approved)' : ''}`, stepsLine(output)].filter(Boolean)}>
            {#snippet details()}
              {#each [{ label: 'plugin.ts', text: output.code }, { label: 'plugin.test.ts', text: output.tests }] as file}
                {#if file.text}
                  <div class="mt-2 flex items-center justify-between gap-2">
                    <span>{file.label}</span>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background"
                      onclick={() => copy(file.text)}
                      aria-label={m.plugin_writer_copy({ file: file.label })}
                      data-testid="plugin-writer-copy"><Copy class="size-3" />{m.plugin_writer_copy_short()}</button
                    >
                  </div>
                  <pre class="mt-1 max-h-72 overflow-auto rounded bg-background p-2 break-normal whitespace-pre" data-testid="plugin-writer-source"><code>{file.text}</code></pre>
                {/if}
              {/each}
            {/snippet}
          </ItemLens>
        </div>
      </section>
    {/if}
  </div>

  {#snippet footer()}
    {#if st.phase === 'idle' || st.phase === 'failed'}
      <Button class="w-full" disabled={!canGenerate(st.description)} onclick={generate} data-testid="plugin-writer-generate">
        <Sparkles class="size-4" />{st.phase === 'failed' ? m.plugin_writer_generate_again() : m.plugin_writer_generate()}
      </Button>
    {:else if st.phase === 'generating'}
      <Button class="w-full" variant="secondary" onclick={() => send({ type: 'cancel' })} data-testid="plugin-writer-cancel">{m.common_cancel()}</Button>
    {:else if st.phase === 'enabled'}
      <Button class="w-full" onclick={finish} data-testid="plugin-writer-done">{m.plugin_writer_done()}</Button>
    {:else if st.phase === 'result'}
      <div class="space-y-2">
        {#if block}
          <p class="text-xs text-muted-foreground" data-testid="plugin-writer-block">
            {blockText}
            <button type="button" class="ml-1 underline underline-offset-2" onclick={() => (whyOpen = true)} data-testid="plugin-writer-why">{m.why_button()}</button>
          </p>
        {/if}
        <Button class="w-full" disabled={!!block || !app.hasAction('plugins.enable')} onclick={enable} data-testid="plugin-writer-enable">{m.plugin_writer_enable()}</Button>
        <div class="grid grid-cols-2 gap-2">
          <Button variant="secondary" onclick={retry} data-testid="plugin-writer-retry">{m.plugin_writer_retry()}</Button>
          <Button variant="ghost" onclick={() => discard()} data-testid="plugin-writer-discard">{m.plugin_writer_discard()}</Button>
        </div>
      </div>
    {/if}
  {/snippet}
</Sheet>

<Sheet bind:open={whyOpen} title={m.plugin_writer_why_title()} testid="plugin-writer-why-sheet">
  {#if output}
    <div class="space-y-3 text-sm">
      <p>{blockText}</p>
      {#if block === 'tests-failed'}
        <p class="text-muted-foreground">{m.plugin_writer_why_tests()}</p>
        <ul class="space-y-1">
          {#each cases.filter((c) => c.ok === false) as c}
            <li class="flex items-start gap-2"><CircleX class="mt-0.5 size-4 shrink-0 text-destructive" />{c.name}</li>
          {/each}
        </ul>
      {:else}
        <p class="text-muted-foreground">{output.note}</p>
      {/if}
      <p class="text-muted-foreground">{m.plugin_writer_why_next()}</p>
      {#if output.testResult?.output}<ItemLens lines={[output.testResult.output]} />{/if}
    </div>
  {/if}
  {#snippet footer()}
    <Button
      class="w-full"
      onclick={() => {
        whyOpen = false;
        retry();
      }}>{m.plugin_writer_retry()}</Button
    >
  {/snippet}
</Sheet>

<style>
  @keyframes -global-writer-progress {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(300%);
    }
  }
</style>
