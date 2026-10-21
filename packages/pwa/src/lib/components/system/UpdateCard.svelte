<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One-tap update (§14): current version, "Update to X" (preview → apply),
   * live progress while it backs up, downloads, restarts and checks itself,
   * and a "go back" row that stays until the next update.
   */
  import { onDestroy, onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Circle from '@lucide/svelte/icons/circle';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import {
    type StepId,
    type UpdateFlowState,
    canRollback,
    initialState,
    percent,
    pollDelay,
    reduce,
    steps,
  } from './progress';
  import type { UpdateCheck, UpdateStatus } from './types';

  let check = $state<UpdateCheck | null>(null);
  let loading = $state(true);
  let st = $state<UpdateFlowState>(initialState(null));
  /** What the running job is: an update or going back. */
  let mode = $state<'update' | 'rollback'>('update');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  const stepLabel: Record<StepId, () => string> = {
    backup: () => m.system_step_backup(),
    download: () => m.system_step_download(),
    verify: () => m.system_step_verify(),
    install: () => m.system_step_install(),
    restart: () => m.system_step_restart(),
    check: () => m.system_step_check(),
  };

  const busy = $derived(st.stage === 'running' || st.stage === 'offline');
  const pct = $derived(percent(st));
  const target = $derived(st.status?.to ?? check?.latest ?? '');

  async function load() {
    loading = true;
    const [c, s] = await Promise.all([
      query<UpdateCheck>('system.update-check'),
      query<UpdateStatus>('system.update-status'),
    ]);
    if (!alive) return;
    check = c;
    st = initialState(s);
    loading = false;
    schedule();
  }

  async function poll() {
    let s: UpdateStatus | null = null;
    try {
      s = (await app.api.run<UpdateStatus>('system.update-status', {}, 'node')).output;
    } catch {
      s = null;
    }
    if (!alive) return;
    const before = st.stage;
    st = s
      ? reduce(st, { type: 'status', status: s, now: Date.now() })
      : reduce(st, { type: 'poll-failed', now: Date.now() });
    if (before !== st.stage) finished(before);
    schedule();
  }

  function finished(before: string) {
    if (before !== 'running' && before !== 'offline') return;
    if (st.stage === 'done') {
      // "Go back" from the toast; the row below keeps offering it until the next update.
      toasts.success(m.system_update_done_toast({ version: st.status?.to ?? '' }), async () => rollback());
      void refreshCheck();
    } else if (st.stage === 'rolled-back') {
      toasts.show({ message: st.status?.message ?? m.system_rolled_back(), kind: 'info' });
      void refreshCheck();
    } else if (st.stage === 'failed') {
      toasts.error(st.error === 'gone' ? m.system_server_gone() : (st.status?.message ?? m.system_update_failed()));
    }
  }

  async function refreshCheck() {
    const c = await query<UpdateCheck>('system.update-check');
    if (alive && c) check = c;
  }

  function schedule() {
    clearTimeout(timer);
    const d = pollDelay(st);
    if (d !== null && alive) timer = setTimeout(poll, d);
  }

  function update() {
    const def = app.action('system.update');
    if (!def || !check?.latest) return;
    const c = check;
    void flow.start(def, { version: c.latest }, {
      onDone: (r) => {
        mode = 'update';
        const out = r.output as Partial<UpdateStatus>;
        st = reduce(st, {
          type: 'started',
          status: {
            phase: 'backing-up',
            updatedAt: 0,
            message: '',
            ...out,
            current: c.current,
            previousVersion: st.status?.previousVersion ?? null,
            busy: true,
          },
        });
        schedule();
      },
    });
  }

  function rollback() {
    const def = app.action('system.rollback');
    if (!def) return;
    void flow.start(def, { restoreBackup: false }, {
      form: true,
      onDone: () => {
        mode = 'rollback';
        if (st.status)
          st = reduce(st, {
            type: 'started',
            status: { ...st.status, phase: 'restarting', busy: true },
          });
        schedule();
      },
    });
  }

  function restoreBackup() {
    const def = app.action('backups.restore');
    const id = st.status?.backupId;
    if (def && id) void flow.start(def, { id });
  }

  onMount(load);
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });
</script>

<section class="rounded-xl border p-4" aria-labelledby="update-title" id="update" data-testid="update-card">
  <div class="flex items-center gap-2">
    <h2 id="update-title" class="flex-1 text-sm font-medium">{m.system_update_title()}</h2>
    {#if check && !busy}
      {#if check.updateAvailable}
        <Badge tone="accent">{m.system_update_available()}</Badge>
      {:else if check.latest}
        <Badge tone="ok">{m.system_up_to_date()}</Badge>
      {/if}
    {/if}
  </div>

  {#if loading}
    <p class="mt-2 text-sm text-muted-foreground">{m.system_loading()}</p>
  {:else if !check}
    <p class="mt-2 text-sm text-muted-foreground">{m.system_update_unknown()}</p>
  {:else}
    <p class="mt-1 text-sm" data-testid="current-version">{m.system_current_version({ version: check.current })}</p>

    {#if busy}
      <div class="mt-3" data-testid="update-progress" aria-live="polite">
        {#if mode === 'rollback'}
          <p class="flex items-center gap-2 text-sm">
            <LoaderCircle class="size-4 animate-spin text-primary" />
            {m.system_rolling_back()}
          </p>
        {:else}
          <p class="text-sm font-medium">{m.system_updating_to({ version: target })}</p>
          <ol class="mt-2 space-y-1.5">
            {#each steps(st) as step (step.id)}
              <li class="flex items-center gap-2 text-sm" data-testid={`step-${step.id}`} data-status={step.status}>
                {#if step.status === 'done'}<Check class="size-4 text-success" />
                {:else if step.status === 'active'}<LoaderCircle class="size-4 animate-spin text-primary" />
                {:else if step.status === 'failed'}<X class="size-4 text-destructive" />
                {:else}<Circle class="size-4 text-muted-foreground/50" />{/if}
                <span class={step.status === 'pending' ? 'text-muted-foreground' : ''}>{stepLabel[step.id]()}</span>
                {#if step.id === 'download' && step.status === 'active' && pct !== undefined}
                  <span class="ml-auto font-mono text-xs text-muted-foreground">{pct}%</span>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
        {#if st.stage === 'offline'}
          <p class="mt-2 text-xs text-muted-foreground">{m.system_offline_note()}</p>
        {:else if st.status?.message}
          <p class="mt-2 text-xs text-muted-foreground">{st.status.message}</p>
        {/if}
      </div>
    {:else}
      {#if st.stage === 'failed' || st.stage === 'rolled-back'}
        <div class="mt-3 rounded-lg bg-warning/10 p-3 text-sm" role="status" data-testid="update-outcome">
          <p>{st.error === 'gone' ? m.system_server_gone() : st.status?.message}</p>
          {#if st.stage === 'rolled-back' && st.status?.backupId && app.hasAction('backups.restore')}
            <p class="mt-1 text-xs text-muted-foreground">{m.system_backup_offer()}</p>
            <Button size="sm" variant="secondary" class="mt-2" onclick={restoreBackup} data-testid="restore-backup">{m.system_restore_backup()}</Button>
          {/if}
          <ItemLens lines={[`phase ${st.phase}`, ...(st.status?.technical ? [st.status.technical] : [])]} />
        </div>
      {/if}

      {#if check.updateAvailable && check.latest}
        {#if check.notesSummary}
          <div class="mt-3 rounded-lg bg-muted/50 p-3 text-sm" data-testid="release-notes">
            <p class="text-xs font-medium text-muted-foreground">{m.system_whats_new({ version: check.latest })}</p>
            <p class="mt-1 whitespace-pre-line">{check.notesSummary}</p>
          </div>
        {/if}
        {#if check.blocked}
          <p class="mt-3 text-sm text-muted-foreground" data-testid="update-blocked">{check.blocked}</p>
        {:else if app.hasAction('system.update')}
          <Button class="mt-3 w-full sm:w-auto" onclick={update} data-testid="update-now">{m.system_update_to({ version: check.latest })}</Button>
          <p class="mt-2 text-xs text-muted-foreground">{m.system_update_safety()}</p>
        {/if}
      {:else if check.blocked}
        <p class="mt-2 text-sm text-muted-foreground" data-testid="update-blocked">{check.blocked}</p>
      {/if}

      {#if canRollback(st) && app.hasAction('system.rollback')}
        <div class="mt-3 flex items-center gap-3 rounded-lg border border-dashed p-3" data-testid="rollback-row">
          <p class="min-w-0 flex-1 text-sm">{m.system_previous_kept({ version: st.status?.previousVersion ?? '' })}</p>
          <Button size="sm" variant="secondary" onclick={rollback} data-testid="rollback">{m.system_go_back()}</Button>
        </div>
      {/if}
    {/if}

    <ItemLens lines={[check.technical, `runtime ${check.runtime} · install ${check.install.kind}`]} />
  {/if}
</section>
