<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Backups and restore (§6.13, vanilla). Top task in ≤ 3 taps: Settings →
   * Backups and restore → Back up now. Each backup shows when, how big and
   * whether it was checked; Check runs `backups.verify`, Restore opens the
   * preview → confirm flow (owner only; with the approvals module on, a
   * second admin approves first). Standby (Litestream) status and the
   * technical details live behind the lens.
   */
  import { onDestroy, onMount } from 'svelte';
  import Archive from '@lucide/svelte/icons/archive';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Server from '@lucide/svelte/icons/server';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow, query, runNow } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { to } from '$lib/nav';
  import { ago, formatBytes } from '$lib/utils';
  import Button, { buttonVariants } from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import {
    type BackupRow,
    type BackupsList,
    type VerifyOutput,
    POLL_MS,
    checkState,
    health,
    lensLines,
    sorted,
    when,
  } from './backups';

  let data = $state<BackupsList | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let checking = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  const rows = $derived(data ? sorted(data.backups) : []);
  const status = $derived(data ? health(data) : 'off');
  const canRestore = $derived(app.hasAction('backups.restore'));
  const every = $derived(
    data?.schedule?.enabled
      ? data.schedule.schedule === 'hourly'
        ? m.backups_every_hourly()
        : data.schedule.schedule === 'weekly'
          ? m.backups_every_weekly()
          : m.backups_every_daily()
      : null,
  );

  async function load() {
    const out = await query<BackupsList>('backups.list');
    if (!alive) return;
    data = out;
    loading = false;
    clearTimeout(timer);
    if (out?.running) timer = setTimeout(() => void load(), POLL_MS);
  }

  async function backUpNow() {
    busy = true;
    const r = await runNow('backups.run-now', {});
    busy = false;
    if (r) void load();
  }

  async function check(b: BackupRow) {
    const def = app.action('backups.verify');
    if (!def) return;
    checking = b.id;
    try {
      const r = await app.api.run<VerifyOutput>('backups.verify', { id: b.id }, def.scope);
      if (r.output.ok) toasts.success(m.backups_check_ok());
      else toasts.error(m.backups_check_bad({ problem: r.output.problems[0] ?? '' }));
    } catch (err) {
      const e = asApiError(err);
      toasts.error(e.message, e.technical);
    }
    checking = null;
    void load();
  }

  function restore(id: string) {
    const def = app.action('backups.restore');
    if (def) void flow.start(def, { id }, { onDone: () => void load() });
  }

  function open(actionId: string) {
    const def = app.action(actionId);
    if (def) void flow.start(def, {}, { onDone: () => void load() });
  }

  onMount(load);
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });
</script>

<div class="space-y-6 md:max-w-2xl" data-testid="backups-screen">
  <p class="text-sm text-muted-foreground">{m.backups_intro()}</p>

  {#if loading}
    <Skeleton class="h-28 w-full" />
    <Skeleton class="h-40 w-full" />
  {:else if !data || status === 'off'}
    <section class="rounded-xl border p-4" data-testid="backups-off">
      <p class="text-sm font-medium">{m.backups_off()}</p>
      <p class="mt-1 text-sm text-muted-foreground">{m.backups_off_hint()}</p>
      <a href={to('/settings/backups')} class={buttonVariants({ class: 'mt-3' })} data-testid="backups-set-up">{m.backups_set_up()}</a>
    </section>
  {:else}
    <section class="rounded-xl border p-4" data-testid="backups-status">
      <div class="flex items-start gap-3">
        {#if status === 'failed'}
          <CircleAlert class="mt-0.5 size-5 shrink-0 text-destructive" />
        {:else}
          <Archive class="mt-0.5 size-5 shrink-0 text-primary" />
        {/if}
        <div class="min-w-0 flex-1 text-sm">
          {#if status === 'failed' && data.last}
            <p class="font-medium text-destructive" data-testid="backups-last">{m.backups_failed({ error: data.last.error ?? '' })}</p>
          {:else if rows[0]}
            <p class="font-medium" data-testid="backups-last">{m.backups_last({ ago: ago(rows[0].at), size: formatBytes(rows[0].size) })}</p>
          {:else}
            <p class="font-medium" data-testid="backups-last">{m.backups_never()}</p>
          {/if}
          <p class="mt-0.5 text-xs text-muted-foreground" data-testid="backups-schedule">
            {#if every && data.schedule}{every}, {m.backups_keep({ keep: data.schedule.keep })}{:else}{m.backups_manual_only()}{/if}
          </p>
        </div>
        {#if status === 'failed'}<WhyButton subject={{ subject: 'health', subsystem: 'backups' }} />{/if}
      </div>
      <Button class="mt-3 w-full md:w-auto" onclick={backUpNow} disabled={busy || !!data.running || !app.hasAction('backups.run-now')} data-testid="backup-now">
        {busy || data.running ? m.backups_running() : m.backups_now()}
      </Button>
      <div class="mt-2"><ItemLens lines={[`target ${data.target ?? 'none'}`, 'actions: backups.run-now · backups.list (DocStore lifecycle.backups)']} /></div>
    </section>

    {#if rows.length}
      <section aria-labelledby="backups-list-title">
        <h2 id="backups-list-title" class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.backups_list_title()}</h2>
        <ul class="divide-y overflow-hidden rounded-xl border" data-testid="backups-list">
          {#each rows as b (b.id)}
            {@const cs = checkState(b)}
            <li class="p-3.5" data-testid="backup-row" data-id={b.id}>
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="text-sm" data-testid="backup-when">{when(b.at)}</p>
                  <p class="text-xs text-muted-foreground">
                    {formatBytes(b.size)} · {b.trigger === 'scheduled' ? m.backups_auto() : m.backups_by_hand()} · {ago(b.at)}
                  </p>
                </div>
                <Badge tone={cs === 'ok' ? 'ok' : cs === 'bad' ? 'critical' : 'neutral'}>
                  <span data-testid="backup-check-state" data-state={cs}>
                    {#if cs === 'ok'}<CircleCheck class="inline size-3" /> {m.backups_checked()}{:else if cs === 'bad'}{m.backups_damaged()}{:else}{m.backups_unchecked()}{/if}
                  </span>
                </Badge>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onclick={() => check(b)} disabled={checking === b.id} data-testid="backup-check">
                  {checking === b.id ? m.common_checking() : m.backups_check()}
                </Button>
                {#if canRestore}
                  <Button size="sm" variant="outline" onclick={() => restore(b.id)} data-testid="backup-restore">{m.backups_restore()}</Button>
                {/if}
                <span class="ml-auto"><ItemLens lines={lensLines(b)} /></span>
              </div>
            </li>
          {/each}
        </ul>
        {#if !canRestore}<p class="mt-2 px-1 text-xs text-muted-foreground" data-testid="restore-owner-only">{m.backups_restore_owner()}</p>{/if}
      </section>
    {/if}

    {#if data.unknownArchives.length}
      <section aria-labelledby="backups-found-title">
        <h2 id="backups-found-title" class="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.backups_found_title()}</h2>
        <p class="mb-2 px-1 text-xs text-muted-foreground">{m.backups_found_hint()}</p>
        <ul class="divide-y overflow-hidden rounded-xl border" data-testid="backups-found">
          {#each data.unknownArchives as a (a.sha256)}
            <li class="flex items-center gap-3 p-3.5">
              <span class="min-w-0 flex-1 text-sm">{m.backups_found_row({ size: formatBytes(a.size) })}</span>
              <ItemLens lines={[`sha256 ${a.sha256}`]} />
              {#if canRestore}<Button size="sm" variant="outline" onclick={() => restore(a.sha256)}>{m.backups_restore()}</Button>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}

  {#if data}
    <section class="rounded-xl border p-4" data-testid="backups-standby">
      <div class="flex items-start gap-3">
        <Server class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1 text-sm">
          <p class="font-medium">{m.backups_standby_title()}</p>
          <p class="mt-0.5 text-xs {data.standby?.status === 'critical' ? 'text-destructive' : data.standby?.status === 'warn' ? 'text-warning' : 'text-muted-foreground'}" data-testid="standby-status">
            {data.standby?.enabled ? (data.standby.message ?? '') : m.backups_standby_off()}
          </p>
        </div>
        {#if data.standby?.status && data.standby.status !== 'ok'}
          <WhyButton subject={{ subject: 'health', subsystem: 'backups' }} />
        {/if}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        {#if app.hasAction('backups.litestream-config')}
          <Button size="sm" variant="secondary" onclick={() => open('backups.litestream-config')} data-testid="standby-file">{m.backups_standby_file()}</Button>
        {/if}
        <span class="ml-auto"><ItemLens lines={[data.standby?.technical ?? 'litestream (modules.lifecycle.litestream.enabled=false)', 'playbook lifecycle.failover']} /></span>
      </div>
    </section>

    <section aria-labelledby="backups-more-title">
      <h2 id="backups-more-title" class="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.backups_more()}</h2>
      <div class="divide-y overflow-hidden rounded-xl border">
        <a href={to('/settings/backups')} class="flex items-center gap-3 p-3.5 hover:bg-muted/40" data-testid="backups-settings-link">
          <span class="min-w-0 flex-1">
            <span class="block text-sm">{m.backups_settings()}</span>
            <span class="block truncate text-xs text-muted-foreground">{m.backups_settings_hint()}</span>
          </span>
          <ChevronRight class="size-4 text-muted-foreground" />
        </a>
        {#if app.hasAction('retention.run-now')}
          <button class="flex w-full items-center gap-3 p-3.5 text-left hover:bg-muted/40" onclick={() => open('retention.run-now')} data-testid="retention-run">
            <span class="min-w-0 flex-1">
              <span class="block text-sm">{m.backups_cleanup()}</span>
              <span class="block truncate text-xs text-muted-foreground">{m.backups_cleanup_hint()}</span>
            </span>
            <ChevronRight class="size-4 text-muted-foreground" />
          </button>
        {/if}
      </div>
    </section>
  {/if}
</div>
