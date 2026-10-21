<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** People (§6.1): users, team & roles, invites, access mode. */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import Ticket from '@lucide/svelte/icons/ticket';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query, runNow } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import type { BlobItem, RelayConfig, RunResult } from '$lib/api/types';
  import { mergeUsers, quotaOf, type UserRow } from '$lib/components/people/users';
  import QuotaBar from '$lib/components/people/QuotaBar.svelte';
  import { ago, formatBytes } from '$lib/utils';
  import { names } from '$lib/stores/names.svelte';
  import { to } from '$lib/nav';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import SwipeRow from '$lib/components/SwipeRow.svelte';
  import UserSheet from '$lib/components/people/UserSheet.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import InsightsLink from '$lib/components/home/InsightsLink.svelte';
  import { m } from '$lib/paraglide/messages.js';

  interface Admin {
    id: string;
    pubkey?: string;
    displayName: string;
    roles: Record<string, string>;
    createdAt: number;
  }

  const tab = $derived(page.url.searchParams.get('tab') ?? 'users');
  let users = $state<UserRow[] | null>(null);
  let admins = $state<Admin[]>([]);
  let filter = $state('');
  let selected = $state<UserRow | null>(null);
  let invites = $state<Array<{ code: string; kind: 'member' | 'admin'; expiresAt?: number }>>([]);
  let relayCfg = $state<RelayConfig | null>(null);
  let fromModule = $state(false);

  async function load() {
    const [team, listed, blobs] = await Promise.all([
      query<{ admins: Admin[] }>('admins.list'),
      query<{ users: UserRow[] }>('users.list', { limit: 500 }),
      query<{ items: BlobItem[] }>('media.list-blobs', { limit: 500 }),
    ]);
    admins = team?.admins ?? [];
    fromModule = !!listed;
    users = listed?.users ?? mergeUsers(blobs?.items ?? [], live.items, admins);
    names.rememberRows(admins);
    names.rememberRows(users);
    relayCfg = (await app.api.relayConfig().catch(() => null))?.relay ?? null;
  }
  onMount(load);

  const shown = $derived(
    (users ?? []).filter(
      (u) => !filter || u.pubkey.includes(filter.toLowerCase()) || (u.name ?? '').toLowerCase().includes(filter.toLowerCase()),
    ),
  );

  function start(id: string, input: Record<string, unknown>, form = false, onDone?: (r: RunResult) => void) {
    const def = app.action(id);
    if (!def) return;
    void flow.start(def, input, { form, onDone: (r) => (onDone ? onDone(r) : void load()), onUndo: () => void load() });
  }

  const roleLabel = (r: string) =>
    ({ owner: m.role_owner(), admin: m.role_admin(), moderator: m.role_moderator(), viewer: m.role_viewer() })[r] ?? r;

  function inviteMember() {
    start('access.create-invite', {}, true, (r) => {
      const o = r.output as { code: string; expiresAt: number };
      invites = [{ code: o.code, kind: 'member', expiresAt: o.expiresAt }, ...invites];
    });
  }
  function inviteAdmin() {
    start('admins.invite', { role: 'moderator' }, true, (r) => {
      const o = r.output as { code?: string; expiresAt?: number };
      if (o.code) invites = [{ code: o.code, kind: 'admin', ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}) }, ...invites];
      void load();
    });
  }

  const sectionLinks = $derived(app.uiRoutes.filter((r) => r.placement === 'people-section'));
  const accessMode = $derived(relayCfg?.access.mode);
</script>

<svelte:head><title>{m.nav_people()} · {m.app_name()}</title></svelte:head>

<div class="mb-3 flex items-center justify-between">
  <h1 class="text-xl font-semibold tracking-tight">{m.nav_people()}</h1>
  <InsightsLink section="community" />
</div>
<Segmented
  label={m.nav_people()}
  tabs={[
    { id: 'users', label: m.people_tab_users() },
    { id: 'team', label: m.people_tab_team(), count: admins.length },
    { id: 'invites', label: m.people_tab_invites() },
    { id: 'access', label: m.people_tab_access() },
  ]}
/>

<div class="mt-4">
  {#if tab === 'team'}
    <div class="mb-3 flex justify-end">
      {#if app.hasAction('admins.invite') && app.can('admins.manage', false)}
        <Button size="sm" onclick={inviteAdmin}><UserPlus class="size-4" />{m.team_invite()}</Button>
      {/if}
    </div>
    <ul class="divide-y rounded-xl border" data-testid="team-list">
      {#each admins as a (a.id)}
        <li>
          <SwipeRow
            right={app.can('admins.manage', false)
              ? [
                  { id: 'role', label: m.team_change_role(), tone: 'accent', run: () => start('admins.set-role', { id: a.id }, true) },
                  { id: 'remove', label: m.team_remove(), tone: 'critical', run: () => start('admins.remove', { id: a.id }) },
                ]
              : []}
          >
            <div class="flex items-center gap-3 p-3">
              <div class="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-medium">{a.displayName.slice(0, 1).toUpperCase()}</div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">{a.displayName}</p>
                <p class="text-xs text-muted-foreground">
                  {Object.entries(a.roles)
                    .map(([scope, r]) => (scope === '*' ? roleLabel(r) : `${roleLabel(r)} · ${scope}`))
                    .join(', ')}
                </p>
                {#if prefs.lens}<p class="truncate font-mono text-[10px] text-muted-foreground">{a.id}</p>{/if}
              </div>
              {#if a.id === app.me?.id}<Badge>{m.team_you()}</Badge>{/if}
            </div>
          </SwipeRow>
        </li>
      {/each}
    </ul>
  {:else if tab === 'invites'}
    <div class="grid gap-2 sm:grid-cols-2">
      {#if app.hasAction('access.create-invite')}
        <Button variant="secondary" class="h-auto justify-start py-3" onclick={inviteMember}>
          <Ticket class="size-4" />
          <span class="text-left"><span class="block">{m.invite_member()}</span><span class="block text-xs font-normal text-muted-foreground">{m.invite_member_desc()}</span></span>
        </Button>
      {/if}
      {#if app.hasAction('admins.invite') && app.can('admins.manage', false)}
        <Button variant="secondary" class="h-auto justify-start py-3" onclick={inviteAdmin}>
          <UserPlus class="size-4" />
          <span class="text-left"><span class="block">{m.team_invite()}</span><span class="block text-xs font-normal text-muted-foreground">{m.invite_admin_desc()}</span></span>
        </Button>
      {/if}
    </div>
    {#if invites.length}
      <ul class="mt-4 divide-y rounded-xl border" data-testid="invites">
        {#each invites as i (i.code)}
          <li class="flex items-center gap-3 p-3">
            <code class="flex-1 truncate font-mono text-sm">{i.code}</code>
            <Badge>{i.kind === 'admin' ? m.invite_kind_admin() : m.invite_kind_member()}</Badge>
            <Button size="sm" variant="ghost" onclick={() => navigator.clipboard?.writeText(i.code)}>{m.common_copy()}</Button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-4 text-sm text-muted-foreground">{m.invites_note()}</p>
    {/if}
  {:else if tab === 'access'}
    <a href={to('/settings/access')} class="flex items-center gap-3 rounded-xl border p-4">
      <div class="flex-1">
        <p class="text-sm font-medium">{m.access_who_can_post()}</p>
        <p class="text-xs text-muted-foreground">
          {accessMode === 'allowlist' ? m.access_mode_allowlist() : accessMode === 'wot' ? m.access_mode_wot() : m.access_mode_open()}
        </p>
      </div>
      <ChevronRight class="size-4 text-muted-foreground" />
    </a>
    {#if app.hasAction('access.add-allowlist')}
      <Button variant="secondary" class="mt-3 w-full" onclick={() => start('access.add-allowlist', {}, true)}>{m.access_add_members()}</Button>
    {/if}
  {:else}
    <PullToRefresh onrefresh={load}>
      <input
        type="search"
        class="mb-3 h-10 w-full rounded-lg border bg-background px-3 text-sm"
        placeholder={m.people_search()}
        aria-label={m.people_search()}
        bind:value={filter}
      />
      {#if !fromModule && users}
        <p class="mb-2 text-xs text-muted-foreground">{m.people_derived_note()}</p>
      {/if}
      {#if users === null}
        <div class="space-y-2"><Skeleton class="h-14 w-full" /><Skeleton class="h-14 w-full" /><Skeleton class="h-14 w-full" /></div>
      {:else if shown.length === 0}
        <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{m.people_empty()}</p>
      {:else}
        <ul class="divide-y overflow-hidden rounded-xl border" data-testid="users-list">
          {#each shown as u (u.pubkey)}
            <li>
              <SwipeRow
                testid="user-row"
                left={[{ id: 'inspect', label: m.people_inspect(), tone: 'neutral', run: () => (selected = u) }]}
                right={app.can('moderation.write')
                  ? [
                      { id: 'tier', label: m.people_tier(), tone: 'accent', run: () => start('users.set-tier', { pubkey: u.pubkey, tier: null }, true) },
                      { id: 'mute', label: m.people_mute(), tone: 'warn', run: () => runNow('moderation.mute-pubkey', { pubkeys: [u.pubkey] }, { afterUndo: load }) },
                      { id: 'ban', label: m.people_ban(), tone: 'critical', run: () => runNow('moderation.ban-pubkey', { pubkeys: [u.pubkey] }, { afterUndo: load }) },
                    ]
                  : []}
              >
                {@const q = quotaOf(u)}
                <button class="flex w-full items-center gap-3 p-3 text-left" onclick={() => (selected = u)}>
                  <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px]">{u.pubkey.slice(0, 2)}</div>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{u.name ?? names.label(u.pubkey)}</p>
                    <p class="text-xs text-muted-foreground">
                      {u.tier ?? m.people_default_tier()} · {u.lastSeen ? ago(u.lastSeen) : m.people_not_seen()}
                      {#if u.storageBytes && !q}· {formatBytes(u.storageBytes)}{/if}
                    </p>
                    {#if q}<QuotaBar {q} compact />{/if}
                  </div>
                  {#if u.banned}<Badge tone="critical">{m.people_banned()}</Badge>{/if}
                  {#if u.admin}<Badge>{m.people_team_member()}</Badge>{/if}
                </button>
              </SwipeRow>
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-center text-[11px] text-muted-foreground md:hidden">{m.people_swipe_hint()}</p>
      {/if}
    </PullToRefresh>
  {/if}

  {#each sectionLinks as r (r.path)}
    <a class="mt-4 block text-sm text-primary" href={to(`/m${r.path}`)}>{r.title}</a>
  {/each}
</div>

<UserSheet bind:user={selected} onchange={load} />
