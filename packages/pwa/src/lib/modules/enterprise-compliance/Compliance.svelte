<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Settings › Compliance (§12.7): legal holds, exports for legal review
   * (eDiscovery) with file downloads, security-log destinations (SIEM) with a
   * test, and the data-location check. The simple view keeps to a few
   * controls; usage reports and released holds sit in the Advanced sheet.
   */
  import { onMount } from 'svelte';
  import Download from '@lucide/svelte/icons/download';
  import Gavel from '@lucide/svelte/icons/gavel';
  import Archive from '@lucide/svelte/icons/archive';
  import Activity from '@lucide/svelte/icons/activity';
  import MapPin from '@lucide/svelte/icons/map-pin';
  import Check from '@lucide/svelte/icons/check';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, query } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import OutputView from '$lib/components/OutputView.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import Waiting from '../shared/Waiting.svelte';
  import { requests, startAction } from '../shared/requests.svelte.ts';
  import { ago } from '../shared/approvals.ts';
  import {
    type ExportRecord,
    type LegalHold,
    type ResidencyIssue,
    type SinkStatus,
    base64Bytes,
    fileSize,
    lastMonth,
    sinkName,
    sinkText,
    sinkTone,
  } from './compliance.ts';

  let holds = $state<LegalHold[] | null>(null);
  let released = $state<LegalHold[]>([]);
  let exports = $state<ExportRecord[] | null>(null);
  let sinks = $state<Record<string, SinkStatus> | null>(null);
  let residency = $state<ResidencyIssue[] | null>(null);
  let advancedOpen = $state(false);
  let month = $state(lastMonth());
  let report = $state<unknown>(null);
  let reporting = $state(false);
  let downloading = $state<string | null>(null);

  async function loadHolds() {
    const r = await query<{ holds: LegalHold[] }>('compliance.list-holds', { includeReleased: true });
    const all = r?.holds ?? [];
    holds = all.filter((h) => h.status === 'active');
    released = all.filter((h) => h.status === 'released');
  }
  async function loadExports() {
    exports = (await query<{ exports: ExportRecord[] }>('compliance.list-exports', {}))?.exports ?? [];
  }
  async function loadSinks() {
    sinks = (await query<{ sinks: Record<string, SinkStatus> }>('compliance.siem-status', {}))?.sinks ?? {};
  }
  async function loadResidency() {
    residency = (await query<{ issues: ResidencyIssue[] }>('compliance.check-residency', {}))?.issues ?? null;
  }
  onMount(() => {
    void loadHolds();
    void loadExports();
    void loadSinks();
    void loadResidency();
    void requests.load();
  });

  function startHold() {
    startAction('compliance.create-hold', {}, { form: true, after: loadHolds });
  }
  function release(h: LegalHold) {
    startAction('compliance.release-hold', { holdId: h.id }, { form: true, after: loadHolds });
  }
  function newExport() {
    startAction('compliance.export', {}, { form: true, after: loadExports });
  }
  function testSinks() {
    startAction('compliance.test-sink', {}, { after: loadSinks });
  }

  async function download(e: ExportRecord, path: string) {
    const def = app.action('compliance.export-file');
    if (!def) return;
    downloading = `${e.id}/${path}`;
    try {
      const r = await app.api.run<{ path: string; type: string; base64: string }>(
        def.id,
        { exportId: e.id, path },
        def.scope,
      );
      const bytes = base64Bytes(r.output.base64);
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: r.output.type || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${e.name.replace(/[^\w.-]+/g, '-')}-${path.split('/').pop() ?? 'file'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      const x = asApiError(err);
      toasts.error(x.message, x.technical);
    } finally {
      downloading = null;
    }
  }

  async function makeReport() {
    const def = app.action('compliance.usage-report');
    if (!def) return;
    reporting = true;
    try {
      const r = await app.api.run<{ report: { rows: unknown[]; totals: unknown } }>(def.id, { month }, def.scope);
      report = { groups: r.output.report.rows, totals: r.output.report.totals };
      toasts.success(r.summary);
    } catch (err) {
      const x = asApiError(err);
      toasts.error(x.message, x.technical);
    } finally {
      reporting = false;
    }
  }

  const sinkList = $derived(Object.entries(sinks ?? {}));
</script>

<div class="space-y-6 md:max-w-3xl" data-testid="compliance">
  {#if app.hasAction('compliance.list-holds')}
    <section class="rounded-xl border p-4" data-testid="legal-holds">
      <div class="flex items-start gap-2">
        <Gavel class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">Legal holds</h2>
          <p class="text-xs text-muted-foreground">Data under a hold cannot be deleted by anyone until the hold ends.</p>
        </div>
        {#if app.hasAction('compliance.create-hold')}
          <Button size="sm" variant="secondary" onclick={startHold} data-testid="create-hold">Start a legal hold</Button>
        {/if}
      </div>
      {#if holds === null}
        <Skeleton class="mt-3 h-14 w-full" />
      {:else if holds.length === 0}
        <p class="mt-3 text-xs text-muted-foreground">No legal holds right now.</p>
      {:else}
        <ul class="mt-2 divide-y">
          {#each holds as h (h.id)}
            {@const waiting = requests.waiting('compliance.release-hold', { holdId: h.id })}
            <li class="py-3" data-testid="hold-row" data-hold={h.id}>
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">{h.name}</p>
                  <p class="text-xs text-muted-foreground">Keeps everything for {h.describe ?? 'the chosen people'} · since {ago(h.createdAt)}</p>
                  <p class="text-xs text-muted-foreground">“{h.reason}”</p>
                  <ItemLens lines={[`hold ${h.id}`, `scope ${JSON.stringify(h.scope)}`, 'blocks retention, NIP-09/NIP-62 deletion, crypto-shred, recycle purge']} />
                </div>
                {#if app.hasAction('compliance.release-hold') && !waiting}
                  <Button size="sm" variant="ghost" onclick={() => release(h)} data-testid="release-hold">End hold</Button>
                {/if}
              </div>
              {#if waiting}<div class="mt-2"><Waiting row={waiting} after={loadHolds} /></div>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if app.hasAction('compliance.list-exports')}
    <section class="rounded-xl border p-4" data-testid="exports">
      <div class="flex items-start gap-2">
        <Archive class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">Exports for legal review</h2>
          <p class="text-xs text-muted-foreground">Signed archives of posts and files that anyone can check for tampering.</p>
        </div>
        {#if app.hasAction('compliance.export')}
          <Button size="sm" variant="secondary" onclick={newExport} data-testid="new-export">Export data</Button>
        {/if}
      </div>
      {#if exports === null}
        <Skeleton class="mt-3 h-14 w-full" />
      {:else if exports.length === 0}
        <p class="mt-3 text-xs text-muted-foreground">No exports yet.</p>
      {:else}
        <ul class="mt-2 divide-y">
          {#each exports as e (e.id)}
            <li class="py-3" data-testid="export-row">
              <p class="text-sm font-medium">{e.name}</p>
              <p class="text-xs text-muted-foreground">
                {e.counts.events === 1 ? '1 post' : `${e.counts.events} posts`}, {e.counts.blobs === 1 ? '1 file' : `${e.counts.blobs} files`} · {ago(e.createdAt)}
              </p>
              {#if e.truncated}<p class="text-xs text-warning">The limit was reached — narrow the search for a complete export.</p>{/if}
              {#if app.hasAction('compliance.export-file')}
                <div class="mt-2 flex flex-wrap gap-1.5">
                  {#each e.files as f (f.path)}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={downloading === `${e.id}/${f.path}`}
                      onclick={() => download(e, f.path)}
                      data-testid="export-file"
                    >
                      <Download class="size-3.5" />{f.path.split('/').pop()} <span class="text-muted-foreground">{fileSize(f.size)}</span>
                    </Button>
                  {/each}
                </div>
              {/if}
              <ItemLens lines={[`export ${e.id}`, `signed by node key ${e.signer} (BIP-340)`, ...e.files.map((f) => `${f.path} sha256 ${f.sha256}`)]} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if app.hasAction('compliance.siem-status')}
    <section class="rounded-xl border p-4" data-testid="siem">
      <div class="flex items-start gap-2">
        <Activity class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">Security log copies</h2>
          <p class="text-xs text-muted-foreground">Sign-ins, admin changes and key use, copied to your security system.</p>
        </div>
        {#if app.hasAction('compliance.test-sink') && sinkList.length}
          <Button size="sm" variant="secondary" onclick={testSinks} data-testid="test-sink">Send a test</Button>
        {/if}
      </div>
      {#if sinks === null}
        <Skeleton class="mt-3 h-10 w-full" />
      {:else if sinkList.length === 0}
        <p class="mt-3 text-xs text-muted-foreground">No destinations are set up yet.</p>
      {:else}
        <ul class="mt-2 divide-y">
          {#each sinkList as [id, s] (id)}
            <li class="flex items-start gap-2 py-2.5" data-testid="sink-row">
              <div class="min-w-0 flex-1">
                <p class="text-sm">{sinkName(s.type)}</p>
                <p class="text-xs text-muted-foreground">
                  {sinkText(s)}{s.lastSuccessAt ? ` · last ${ago(Math.floor(s.lastSuccessAt > 1e12 ? s.lastSuccessAt / 1000 : s.lastSuccessAt))}` : ''}
                </p>
                <ItemLens lines={[`sink ${id} (${s.type})`, `audit seq ${s.auditSeq ?? 0} · outbox seq ${s.outboxSeq ?? 0} · dropped ${s.dropped}`, ...(s.lastError ? [`last error: ${s.lastError}`] : [])]} />
              </div>
              <Badge tone={sinkTone(s)}>{s.enabled ? (s.failures ? 'Failing' : 'On') : 'Off'}</Badge>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if app.hasAction('compliance.check-residency')}
    <section class="rounded-xl border p-4" data-testid="residency">
      <div class="flex items-start gap-2">
        <MapPin class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">Where data is stored</h2>
          {#if residency === null}
            <p class="text-xs text-muted-foreground">Checking…</p>
          {:else if residency.length === 0}
            <p class="flex items-center gap-1 text-xs text-success" data-testid="residency-ok"><Check class="size-3.5" />All data is in the required regions.</p>
          {:else}
            <ul class="mt-1 space-y-1">
              {#each residency as i (`${i.relayId}:${i.message}`)}
                <li class="text-xs {i.severity === 'critical' ? 'text-destructive' : 'text-warning'}" data-testid="residency-issue">
                  {i.relayId}: {i.message}
                  <ItemLens lines={[i.technical]} />
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    </section>
  {/if}

  <Button variant="secondary" class="w-full md:w-auto" onclick={() => (advancedOpen = true)} data-testid="compliance-advanced">Advanced</Button>
</div>

<Sheet bind:open={advancedOpen} title="Compliance · Advanced" description="Usage reports and past legal holds.">
  <div class="space-y-4">
    {#if app.hasAction('compliance.usage-report')}
      <section class="rounded-lg border p-3" data-testid="usage-report">
        <h3 class="text-sm font-medium">Usage report</h3>
        <p class="text-xs text-muted-foreground">People, posts and storage per company group for one month.</p>
        <div class="mt-2 flex gap-2">
          <input type="month" class="h-10 flex-1 rounded-lg border bg-background px-3 text-sm" aria-label="Month" bind:value={month} />
          <Button variant="secondary" disabled={reporting || !/^\d{4}-\d{2}$/.test(month)} onclick={makeReport} data-testid="make-report">Make report</Button>
        </div>
        {#if report}<div class="mt-3 text-sm"><OutputView value={report} /></div>{/if}
      </section>
    {/if}
    {#if released.length}
      <section class="rounded-lg border p-3" data-testid="released-holds">
        <h3 class="text-sm font-medium">Ended legal holds</h3>
        <ul class="mt-1 divide-y">
          {#each released as h (h.id)}
            <li class="py-2 text-sm">
              <p>{h.name}</p>
              <p class="text-xs text-muted-foreground">Ended {h.releasedAt ? ago(h.releasedAt) : ''}{h.releaseReason ? ` — “${h.releaseReason}”` : ''}</p>
              <ItemLens lines={[`hold ${h.id}`, `scope ${JSON.stringify(h.scope)}`]} />
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if app.hasAction('compliance.check-residency')}
      <Button variant="secondary" class="w-full" onclick={loadResidency}>Check where data is stored again</Button>
    {/if}
  </div>
</Sheet>
