<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * People › Company groups (§12.4, §12.5): what each company directory group
   * may do here (one table), who is in the directory, removing someone's
   * access, directory sync, and disconnecting a sign-in provider (two-person
   * rule when approvals are on). Plain words; provider/SCIM detail in the lens.
   */
  import { onMount } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { app } from '$lib/stores/app.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import { names } from '$lib/stores/names.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import Waiting from '../shared/Waiting.svelte';
  import { requests, startAction } from '../shared/requests.svelte.ts';
  import { ago } from '../shared/approvals.ts';
  import {
    type Mapping,
    type Person,
    type Provider,
    type DirectoryStatus,
    describeAccess,
    personLabel,
    provisioningText,
    ROLE,
    KEYS,
    STATUS,
  } from './groups.ts';

  let mappings = $state<Mapping[] | null>(null);
  let people = $state<Person[] | null>(null);
  let status = $state<DirectoryStatus | null>(null);
  let search = $state('');

  async function loadMappings() {
    const r = await query<{ mappings: Mapping[] }>('enterprise.list-mappings', {});
    mappings = r?.mappings ?? [];
  }
  async function loadPeople() {
    if (!app.hasAction('enterprise.list-people')) {
      people = [];
      return;
    }
    const r = await query<{ people: Person[] }>('enterprise.list-people', {});
    people = r?.people ?? [];
    names.rememberRows(people.map((p) => ({ pubkey: p.pubkey, name: p.name ?? p.email })));
  }
  async function loadStatus() {
    status = await query<DirectoryStatus>('enterprise.directory-status', {});
  }
  function loadAll() {
    void loadMappings();
    void loadPeople();
    void loadStatus();
    void requests.load();
  }
  onMount(loadAll);

  // Key-vault style "waiting for a second admin" errors become waiting requests.
  $effect(() => requests.catchFlow(['enterprise.disconnect-idp', 'enterprise.offboard-person']));

  function addRule() {
    startAction(
      'enterprise.map-group',
      { idp: '*', relays: app.relayId ? [{ relayId: app.relayId, access: 'write' }] : [] },
      { form: true, after: loadMappings },
    );
  }
  function editRule(m: Mapping) {
    const { people: _p, createdAt: _c, createdBy: _b, ...input } = m;
    startAction('enterprise.map-group', input, { form: true, after: loadMappings });
  }
  function removeRule(m: Mapping) {
    startAction('enterprise.unmap-group', { idp: m.idp, group: m.group }, { after: loadMappings });
  }
  function offboard(p: Person) {
    startAction('enterprise.offboard-person', { person: p.email ?? p.key }, { after: loadPeople });
  }
  function disconnect(p: Provider) {
    startAction('enterprise.disconnect-idp', { provider: p.id }, { after: loadStatus });
  }
  function syncNow() {
    startAction('enterprise.sync-directory', {}, {
      after: () => {
        void loadStatus();
        void loadPeople();
      },
    });
  }

  const canDisconnect = $derived(app.action('enterprise.disconnect-idp')?.allowed ?? false);
  const canOffboard = $derived(app.action('enterprise.offboard-person')?.allowed ?? false);
  const canMap = $derived(app.action('enterprise.map-group')?.allowed ?? false);
  const shownPeople = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = people ?? [];
    if (!q) return list;
    return list.filter((p) =>
      [p.name, p.email, ...(p.groups ?? [])].some((v) => v?.toLowerCase().includes(q)),
    );
  });
  const sync = $derived(status?.directorySync);
</script>

<div class="space-y-6 md:max-w-3xl" data-testid="company-groups">
  {#if status && status.providers.length}
    <section class="rounded-xl border p-4" data-testid="company-providers">
      <h2 class="text-sm font-medium">Sign-in providers</h2>
      <ul class="mt-2 divide-y">
        {#each status.providers as p (p.id)}
          {@const waiting = requests.waiting('enterprise.disconnect-idp', { provider: p.id })}
          <li class="py-3" data-testid="provider-row" data-provider={p.id}>
            <div class="flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium">{p.name}</p>
                <p class="text-xs text-muted-foreground">
                  {p.people === 1 ? '1 person' : `${p.people} people`} · {provisioningText(p)}
                </p>
                <ItemLens
                  lines={[
                    `idp id ${p.id} (${p.type === 'oidc' ? 'OIDC' : p.type === 'microsoft' ? 'Entra ID OIDC' : 'Google OIDC'})`,
                    p.provisioning === 'scim'
                      ? `SCIM 2.0 provisioning, token …${p.scimTokenLast4 ?? '????'}`
                      : p.provisioning === 'google'
                        ? 'Google Admin SDK Directory API polling'
                        : 'no provisioning (just-in-time on first sign-in)',
                  ]}
                />
              </div>
              {#if canDisconnect && !waiting}
                <Button size="sm" variant="ghost" class="text-destructive" onclick={() => disconnect(p)} data-testid="disconnect-idp">
                  <LogOut class="size-4" />Disconnect this sign-in provider
                </Button>
              {/if}
            </div>
            {#if waiting}<div class="mt-2"><Waiting row={waiting} after={loadStatus} /></div>{/if}
          </li>
        {/each}
      </ul>
      {#if sync}
        <div class="mt-2 flex items-center gap-3 border-t pt-3" data-testid="directory-sync">
          <div class="min-w-0 flex-1 text-sm">
            {#if sync.enabled}
              <p>
                {sync.lastRunAt ? `Directory synced ${ago(sync.lastRunAt)}` : 'The directory has not synced yet'}
              </p>
              <p class="text-xs text-muted-foreground">
                Checks Google Workspace every {sync.intervalMinutes} min; people who leave lose access.
              </p>
            {:else}
              <p class="text-muted-foreground">Automatic directory sync is off.</p>
            {/if}
            <ItemLens
              lines={[
                `google.directorySync.enabled=${sync.enabled} configured=${sync.configured} idp=${sync.idp}`,
                ...(sync.lastReport ? [`last report ${JSON.stringify(sync.lastReport)}`] : []),
              ]}
            />
          </div>
          {#if sync.enabled && app.hasAction('enterprise.sync-directory')}
            <Button size="sm" variant="secondary" disabled={!sync.configured} onclick={syncNow} data-testid="sync-now">
              <RefreshCw class="size-4" />Sync now
            </Button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  <section class="rounded-xl border p-4" data-testid="group-rules">
    <div class="flex items-center gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-medium">What each company group can do</h2>
        <p class="text-xs text-muted-foreground">Relays, limits, admin role and who keeps the keys — per group.</p>
      </div>
      {#if canMap}
        <Button size="sm" variant="secondary" onclick={addRule} data-testid="add-rule"><Plus class="size-4" />Add a group</Button>
      {/if}
    </div>
    {#if mappings === null}
      <Skeleton class="mt-3 h-20 w-full" />
    {:else if mappings.length === 0}
      <p class="mt-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
        No groups yet. Add one to decide what its members can do.
      </p>
    {:else}
      <div class="mt-3 overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-muted-foreground">
            <tr>
              <th class="px-2 py-1.5 font-medium">Group</th>
              <th class="px-2 py-1.5 font-medium">Can use</th>
              <th class="hidden px-2 py-1.5 font-medium sm:table-cell">Admin role</th>
              <th class="hidden px-2 py-1.5 font-medium sm:table-cell">Keys</th>
              <th class="px-2 py-1.5"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y">
            {#each mappings as row (`${row.idp}:${row.group}`)}
              <tr data-testid="rule-row" data-group={row.group}>
                <td class="px-2 py-2 align-top">
                  <button type="button" class="text-left font-medium hover:underline" onclick={() => editRule(row)} disabled={!canMap}>{row.group}</button>
                  {#if row.people !== undefined}<span class="block text-xs text-muted-foreground">{row.people === 1 ? '1 person' : `${row.people} people`}</span>{/if}
                  <ItemLens lines={[`enterprise.mappings[${row.idp}:${row.group}]`, ...(row.tier ? [`tier ${row.tier}`] : []), `NIP-29 channel ${row.channel ? 'on' : 'off'}`]} />
                </td>
                <td class="px-2 py-2 align-top">{describeAccess(row)}</td>
                <td class="hidden px-2 py-2 align-top sm:table-cell">{row.adminRole ? ROLE[row.adminRole] : '—'}</td>
                <td class="hidden px-2 py-2 align-top sm:table-cell">{row.keyModel ? KEYS[row.keyModel] : 'Default'}</td>
                <td class="px-2 py-2 text-right align-top">
                  {#if canMap && app.hasAction('enterprise.unmap-group')}
                    <Button size="icon" variant="ghost" class="size-8" aria-label={`Remove the rule for ${row.group}`} onclick={() => removeRule(row)} data-testid="remove-rule">
                      <Trash2 class="size-4" />
                    </Button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if app.hasAction('enterprise.list-people')}
    <section class="rounded-xl border p-4" data-testid="company-people">
      <h2 class="text-sm font-medium">People from the company directory</h2>
      <input
        class="mt-3 h-10 w-full rounded-lg border bg-background px-3 text-sm"
        placeholder="Find a person or group"
        aria-label="Find a person or group"
        bind:value={search}
      />
      {#if people === null}
        <Skeleton class="mt-3 h-24 w-full" />
      {:else if shownPeople.length === 0}
        <p class="mt-3 text-center text-xs text-muted-foreground">{people.length ? 'No one matches.' : 'No one has signed in with the company directory yet.'}</p>
      {:else}
        <ul class="mt-2 divide-y">
          {#each shownPeople as p (p.key)}
            {@const waiting = requests.waiting('enterprise.offboard-person', { person: p.email ?? p.key })}
            <li class="py-3" data-testid="person-row" data-person={p.email ?? p.key}>
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">{personLabel(p, names)}</p>
                  <p class="truncate text-xs text-muted-foreground">
                    {p.email && p.email !== personLabel(p, names) ? `${p.email} · ` : ''}{p.groups.length === 1 ? '1 group' : `${p.groups.length} groups`}
                  </p>
                  <ItemLens
                    lines={[
                      `binding ${p.key} (${p.source})`,
                      p.pubkey ? `pubkey ${p.pubkey}` : 'no npub linked yet',
                      `key model ${p.keyModel}`,
                      ...(p.groups.length ? [`groups ${p.groups.join(', ')}`] : []),
                    ]}
                  />
                </div>
                <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                {#if canOffboard && (p.status === 'active' || p.status === 'pending') && !waiting}
                  <Button size="sm" variant="ghost" class="text-destructive" onclick={() => offboard(p)} data-testid="offboard">Remove access</Button>
                {/if}
              </div>
              {#if waiting}<div class="mt-2"><Waiting row={waiting} after={loadPeople} /></div>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

