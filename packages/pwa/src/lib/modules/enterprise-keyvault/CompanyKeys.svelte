<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Settings › Company keys (§12.3, §12.5): where the master key lives, the
   * keys the company holds for people, signing history, switching to a new
   * master key, signing someone out of all apps, and destroying a key after a
   * waiting period (cancel until then; legal holds block it; a second admin
   * may need to approve). KMS / envelope detail lives in the lens.
   */
  import { onMount } from 'svelte';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { app } from '$lib/stores/app.svelte';
  import { query, runNow } from '$lib/stores/actions.svelte';
  import { names } from '$lib/stores/names.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import Waiting from '../shared/Waiting.svelte';
  import { requests, startAction } from '../shared/requests.svelte.ts';
  import { ago } from '../shared/approvals.ts';
  import {
    type AuditRecord,
    type Destruction,
    type ManagedKey,
    type VaultStatus,
    auditText,
    onDate,
    providerName,
  } from './keys.ts';

  const VAULT_ACTIONS = ['keyvault.rotate-kek', 'keyvault.destroy-key'] as const;

  let status = $state<VaultStatus | null>(null);
  let statusFailed = $state(false);
  let keys = $state<ManagedKey[] | null>(null);
  let schedule = $state<Destruction[]>([]);
  let audit = $state<AuditRecord[]>([]);
  let people = $state<Record<string, string>>({});
  let advancedOpen = $state(false);
  let historyLimit = $state(10);

  async function loadStatus() {
    status = await query<VaultStatus>('keyvault.status', {});
    statusFailed = !status;
  }
  async function loadKeys() {
    const [k, d] = await Promise.all([
      query<{ keys: ManagedKey[] }>('keyvault.list-keys', {}),
      query<{ items: Destruction[] }>('enterprise.list-key-destructions', {}),
    ]);
    keys = k?.keys ?? [];
    schedule = d?.items ?? [];
  }
  async function loadAudit() {
    audit = (await query<AuditRecord[]>('keyvault.audit', { limit: 100 })) ?? [];
  }
  async function loadPeople() {
    const r = await query<{ people: Array<{ key: string; name?: string; email?: string; pubkey?: string }> }>(
      'enterprise.list-people',
      {},
    );
    const out: Record<string, string> = {};
    for (const p of r?.people ?? []) {
      const n = p.name || p.email;
      if (n) out[p.key] = n;
      if (p.pubkey && n) names.remember(p.pubkey, n);
    }
    people = out;
  }
  function refresh() {
    void loadStatus();
    void loadKeys();
    void loadAudit();
    void requests.load();
  }
  onMount(() => {
    refresh();
    void loadPeople();
  });

  $effect(() => requests.catchFlow(VAULT_ACTIONS));

  /** A person by name (directory name, Nostr name, else a short key). */
  function who(subjectId: string, pubkey?: string): string {
    return people[subjectId] ?? (pubkey ? names.label(pubkey) : 'Someone from the directory');
  }

  const scheduleBySubject = $derived(new Map(schedule.map((d) => [d.subjectId, d])));
  const rotateWaiting = $derived(
    requests.waiting('keyvault.rotate-kek', { force: false }) ?? requests.waiting('keyvault.rotate-kek', { force: true }),
  );

  function rotate(force = false) {
    advancedOpen = false;
    startAction('keyvault.rotate-kek', { force }, { after: loadStatus });
  }
  function wrapLegacy() {
    advancedOpen = false;
    startAction('keyvault.wrap-legacy-keys', {}, { after: loadStatus });
  }
  function destroy(k: ManagedKey) {
    startAction('keyvault.destroy-key', { subjectId: k.subjectId }, { form: true, after: refresh });
  }
  async function keep(k: ManagedKey) {
    await runNow('keyvault.cancel-destroy', { subjectId: k.subjectId });
    void loadKeys();
  }
  function signOut(k: ManagedKey) {
    startAction('keyvault.revoke-sessions', { subjectId: k.subjectId }, { after: loadAudit });
  }

  const canWrite = $derived(app.action('keyvault.destroy-key')?.allowed ?? false);
</script>

<div class="space-y-6 md:max-w-3xl" data-testid="company-keys">
  <section class="rounded-xl border p-4" data-testid="vault-status">
    {#if status}
      <div class="flex items-start gap-3">
        <KeyRound class="mt-0.5 size-5 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">
            {status.ready ? 'Company keys are protected' : 'The key vault is not ready'}
          </p>
          <p class="text-xs text-muted-foreground">
            Master key kept in {providerName(status.provider)} ·
            {status.keys.active === 1 ? '1 key in use' : `${status.keys.active} keys in use`}{status.keys['pending-destroy']
              ? ` · ${status.keys['pending-destroy']} waiting to be destroyed`
              : ''}
          </p>
          {#if status.error}<p class="mt-1 text-xs text-destructive">{status.error}</p>{/if}
          <ItemLens
            lines={[
              `KEK provider ${status.provider ?? 'none'} · id ${status.kekId ?? '—'}`,
              `${status.dataKeys} DEKs (envelope encryption), ${status.pendingRotation} not yet under the current KEK`,
              ...(status.bunkerPubkey ? [`NIP-46 bunker ${status.bunkerPubkey}`] : []),
              `NIP-17 DM escrow ${status.escrowEnabled ? 'on' : 'off'}`,
              ...(status.signing ? [`signed ${status.signing.signed}, errors ${status.signing.errors}, rate-limited ${status.signing.rateLimited}`] : []),
            ]}
          />
        </div>
        <Badge tone={status.ready ? 'ok' : 'critical'}>{status.ready ? 'Ready' : 'Not ready'}</Badge>
      </div>
      {#if status.pendingRotation > 0}
        <div class="mt-3 flex items-center gap-3 rounded-lg bg-warning/10 p-3 text-sm" data-testid="rotation-needed">
          <p class="flex-1">
            {status.pendingRotation === 1 ? '1 data key still uses' : `${status.pendingRotation} data keys still use`} the old master key.
          </p>
          {#if app.hasAction('keyvault.rotate-kek') && !rotateWaiting}
            <Button size="sm" onclick={() => rotate(false)} data-testid="rotate-kek"><RefreshCw class="size-4" />Switch to the new master key</Button>
          {/if}
        </div>
      {/if}
      {#if rotateWaiting}<div class="mt-3"><Waiting row={rotateWaiting} after={loadStatus} /></div>{/if}
    {:else if statusFailed}
      <p class="text-sm text-muted-foreground">Could not read the key vault status.</p>
    {:else}
      <Skeleton class="h-16 w-full" />
    {/if}
  </section>

  <section class="rounded-xl border p-4" data-testid="managed-keys">
    <h2 class="text-sm font-medium">Keys the company keeps for people</h2>
    <p class="text-xs text-muted-foreground">People with company-held keys sign in through the company; their keys never leave this server.</p>
    {#if keys === null}
      <Skeleton class="mt-3 h-20 w-full" />
    {:else if keys.length === 0}
      <p class="mt-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
        No company-held keys yet. They are created when someone in a “company keeps keys” group first signs in.
      </p>
    {:else}
      <ul class="mt-2 divide-y">
        {#each keys as k (k.subjectId)}
          {@const sched = scheduleBySubject.get(k.subjectId)}
          {@const waiting = requests.waiting('keyvault.destroy-key', { subjectId: k.subjectId })}
          <li class="py-3" data-testid="key-row" data-subject={k.subjectId} data-status={k.status}>
            <div class="flex flex-wrap items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">{who(k.subjectId, k.pubkey)}</p>
                <p class="text-xs text-muted-foreground">
                  {#if k.status === 'destroyed'}
                    Destroyed{k.destroyedAt ? ` ${ago(k.destroyedAt)}` : ''}. Nobody can sign as them again.
                  {:else if k.status === 'pending-destroy'}
                    {k.heldSince
                      ? 'A legal hold keeps this key until the hold ends.'
                      : `Will be destroyed on ${k.destroyAfter ? onDate(k.destroyAfter) : 'soon'}. You can still keep it.`}
                  {:else if sched && sched.status !== 'destroyed'}
                    Left the company · key destroyed on {onDate(sched.dueAt)}{sched.status === 'held' ? ' (held by a legal hold)' : ''}
                  {:else}
                    In use since {onDate(k.createdAt)}
                  {/if}
                </p>
                <ItemLens
                  lines={[
                    `subject ${k.subjectId}`,
                    `pubkey ${k.pubkey}`,
                    `status ${k.status}${k.destroyAfter ? ` · destroyAfter ${k.destroyAfter}` : ''}${k.heldSince ? ` · held since ${k.heldSince}` : ''}`,
                    ...(k.destroyReason ? [`reason: ${k.destroyReason}`] : []),
                    ...(sched ? [`offboarding crypto-shred ${sched.status} due ${sched.dueAt}`] : []),
                  ]}
                />
              </div>
              {#if k.status === 'pending-destroy' && app.hasAction('keyvault.cancel-destroy')}
                <Button size="sm" variant="secondary" onclick={() => keep(k)} data-testid="keep-key">Keep this key</Button>
              {:else if k.status === 'active'}
                {#if app.hasAction('keyvault.revoke-sessions')}
                  <Button size="sm" variant="ghost" onclick={() => signOut(k)} data-testid="revoke-sessions">Sign out of all apps</Button>
                {/if}
                {#if canWrite && !waiting}
                  <Button size="sm" variant="ghost" class="text-destructive" onclick={() => destroy(k)} data-testid="destroy-key">Destroy key</Button>
                {/if}
              {/if}
            </div>
            {#if waiting}<div class="mt-2"><Waiting row={waiting} after={refresh} /></div>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if app.hasAction('keyvault.audit')}
    <section class="rounded-xl border p-4" data-testid="signing-history">
      <h2 class="text-sm font-medium">Signing history</h2>
      {#if audit.length === 0}
        <p class="mt-2 text-xs text-muted-foreground">Nothing signed with company-held keys yet.</p>
      {:else}
        <ul class="mt-2 divide-y">
          {#each audit.slice(0, historyLimit) as r (r.id)}
            <li class="py-2 text-sm" data-testid="audit-row">
              <p>
                <span class="font-medium">{who(r.subjectId, r.pubkey)}</span>
                <span class={r.ok ? '' : 'text-destructive'}>· {auditText(r)}</span>
                {#if r.client}<span class="text-muted-foreground"> in {r.client}</span>{/if}
              </p>
              <p class="text-xs text-muted-foreground">{ago(Math.floor(r.at / 1000))}{r.reason ? ` · “${r.reason}”` : ''}</p>
              <ItemLens
                lines={[
                  `op ${r.op}${r.kind !== undefined ? ` kind ${r.kind}` : ''} via ${r.via ?? '—'}`,
                  ...(r.eventId ? [`event ${r.eventId}`] : []),
                  ...(r.sessionId ? [`NIP-46 session ${r.sessionId}`] : []),
                  ...(r.principalId ? [`admin ${r.principalId}`] : []),
                  ...(r.error ? [`error ${r.error}`] : []),
                ]}
              />
            </li>
          {/each}
        </ul>
        {#if audit.length > historyLimit}
          <button type="button" class="mt-2 w-full rounded-lg border py-2 text-xs text-primary" onclick={() => (historyLimit += 20)}>Show more</button>
        {/if}
      {/if}
    </section>
  {/if}

  {#if app.hasAction('keyvault.wrap-legacy-keys') || app.hasAction('keyvault.rotate-kek')}
    <Button variant="secondary" class="w-full md:w-auto" onclick={() => (advancedOpen = true)} data-testid="keys-advanced">Advanced</Button>
  {/if}
</div>

<Sheet bind:open={advancedOpen} title="Company keys · Advanced" description="Rarely needed. Each step shows what will change first.">
  <div class="space-y-3">
    {#if app.hasAction('keyvault.wrap-legacy-keys')}
      <div class="rounded-lg border p-3">
        <p class="text-sm font-medium">Protect older server keys with the master key</p>
        <p class="text-xs text-muted-foreground">Encrypts keys this server stored before the key vault was turned on.</p>
        <ItemLens lines={['re-wraps alerts.keys/nostr and relay.groups.key/<relay> via ports.keyWrapper']} />
        <Button size="sm" variant="secondary" class="mt-2" onclick={wrapLegacy} data-testid="wrap-legacy">Protect older keys</Button>
      </div>
    {/if}
    {#if app.hasAction('keyvault.rotate-kek')}
      <div class="rounded-lg border p-3">
        <p class="text-sm font-medium">Re-protect every data key</p>
        <p class="text-xs text-muted-foreground">Use this after your cloud key service made a new key version.</p>
        <ItemLens lines={['keyvault.rotate-kek force=true: re-wraps every DEK, including those under the current KEK id']} />
        <Button size="sm" variant="secondary" class="mt-2" onclick={() => rotate(true)} data-testid="rotate-all">Re-protect all data keys</Button>
      </div>
    {/if}
  </div>
</Sheet>
