<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** People (§6.1): users (swipe rows, multi-select bulk actions), team & roles, invites, access mode. */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import UserPlus from '@lucide/svelte/icons/user-plus';
  import Ticket from '@lucide/svelte/icons/ticket';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Check from '@lucide/svelte/icons/check';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query, runNow } from '$lib/stores/actions.svelte';
  import { live } from '$lib/stores/live.svelte';
  import type { BlobItem, RelayConfig, RunResult } from '$lib/api/types';
  import { isRestricted, mergeUsers, quotaOf, userLensLines, type UserRow } from '$lib/components/people/users';
  import { rangeSelect, type BulkKind } from '$lib/components/people/bulk';
  import { longpress } from '$lib/components/people/longpress';
  import QuotaBar from '$lib/components/people/QuotaBar.svelte';
  import { ago, cn, formatBytes } from '$lib/utils';
  import { haptic } from '$lib/haptics';
  import { names } from '$lib/stores/names.svelte';
  import { to } from '$lib/nav';
  import Segmented from '$lib/components/ui/Segmented.svelte';
  import SwipeRow from '$lib/components/SwipeRow.svelte';
  import UserSheet from '$lib/components/people/UserSheet.svelte';
  import BulkSheet from '$lib/components/people/BulkSheet.svelte';
  import WhyButton from '$lib/components/WhyButton.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
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

  // ── Multi-select (§6.13): long-press on phone, checkbox / shift-click on desktop. Swipe is off while selecting. ──
  let selecting = $state(false);
  let picked = $state<Set<string>>(new Set());
  let anchor = $state<string | null>(null);
  let bulkKind = $state<BulkKind | null>(null);
  let bulkKeys = $state<string[]>([]);
  /** The row a long-press just picked: the click that follows the release must not un-pick it. */
  let pressed: { pk: string; at: number } | null = null;

  const canModerate = $derived(app.can('moderation.write'));
  const canUsers = $derived(app.can('users.write'));
  const canBulk = $derived(canModerate || canUsers);
  const allPicked = $derived(shown.length > 0 && shown.every((u) => picked.has(u.pubkey)));
  const pickedRows = $derived((users ?? []).filter((u) => picked.has(u.pubkey)));
  const showUnallow = $derived(
    canUsers && app.hasAction('access.remove-allowlist') && (accessMode === 'allowlist' || pickedRows.some((u) => u.allowlisted)),
  );

  function startSelect(pk: string) {
    if (!canBulk) return;
    haptic('tap');
    selecting = true;
    picked = new Set([...picked, pk]);
    anchor = pk;
    pressed = { pk, at: Date.now() };
  }
  function stopSelect() {
    selecting = false;
    picked = new Set();
    anchor = null;
  }
  function togglePick(pk: string, e?: MouseEvent) {
    if (pressed && pressed.pk === pk && Date.now() - pressed.at < 800) {
      pressed = null;
      return;
    }
    pressed = null;
    if (e?.shiftKey && anchor)
      picked = rangeSelect(
        shown.map((u) => u.pubkey),
        picked,
        anchor,
        pk,
      );
    else {
      const next = new Set(picked);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      picked = next;
    }
    anchor = pk;
  }
  function pickAll() {
    picked = allPicked ? new Set() : new Set(shown.map((u) => u.pubkey));
  }
  function bulk(kind: BulkKind) {
    bulkKeys = [...picked];
    bulkKind = kind;
  }
  function afterBulk() {
    stopSelect();
    void load();
  }
</script>

<svelte:head><title>{m.nav_people()} · {m.app_name()}</title></svelte:head>

<div class="mb-3 flex items-center justify-between">
  <h1 class="text-xl font-semibold tracking-tight">{m.nav_people()}</h1>
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
                <ItemLens lines={[a.id, ...Object.entries(a.roles).map(([scope, r]) => `roles[${scope}] = ${r}`)]} />
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
      <div class="mb-3 flex gap-2">
        <input
          type="search"
          class="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
          placeholder={m.people_search()}
          aria-label={m.people_search()}
          bind:value={filter}
        />
        {#if canBulk && users?.length}
          <Button
            size="sm"
            class="h-10"
            variant={selecting ? 'default' : 'secondary'}
            onclick={() => (selecting ? stopSelect() : (selecting = true))}
            data-testid="people-select"
          >
            {selecting ? m.common_done() : m.common_select()}
          </Button>
        {/if}
      </div>
      {#if !fromModule && users}
        <p class="mb-2 text-xs text-muted-foreground">{m.people_derived_note()}</p>
      {/if}
      {#if selecting && shown.length}
        <button type="button" class="mb-2 flex items-center gap-2 text-sm" role="checkbox" aria-checked={allPicked} onclick={pickAll} data-testid="people-select-all">
          <span class={cn('flex size-5 items-center justify-center rounded border', allPicked && 'border-primary bg-primary text-primary-foreground')}>
            {#if allPicked}<Check class="size-3.5" />{/if}
          </span>
          {m.ppl_select_all()}
        </button>
      {/if}
      {#if users === null}
        <div class="space-y-2"><Skeleton class="h-14 w-full" /><Skeleton class="h-14 w-full" /><Skeleton class="h-14 w-full" /></div>
      {:else if shown.length === 0}
        <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{m.people_empty()}</p>
      {:else}
        <ul class="divide-y overflow-hidden rounded-xl border" data-testid="users-list" data-selecting={selecting ? 'true' : undefined}>
          {#each shown as u (u.pubkey)}
            {@const q = quotaOf(u)}
            {@const isPicked = picked.has(u.pubkey)}
            {#snippet body()}
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
              {#if u.muted}<Badge tone="warn">{m.people_muted()}</Badge>{/if}
              {#if accessMode === 'allowlist' && u.allowlisted === false && !u.admin}<Badge tone="warn">{m.ppl_not_member()}</Badge>{/if}
              {#if u.admin}<Badge>{m.people_team_member()}</Badge>{/if}
            {/snippet}
            {#snippet detail()}
              <div class="flex flex-wrap items-center gap-x-3 px-3 pb-2 pl-15">
                {#if isRestricted(u, accessMode)}<WhyButton subject={{ subject: 'block', pubkey: u.pubkey }} />{/if}
                <ItemLens lines={userLensLines(u)} />
              </div>
            {/snippet}
            <li>
              {#if selecting}
                <div data-testid="user-row" data-picked={isPicked ? 'true' : undefined} class={cn(isPicked && 'bg-primary/5')}>
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 p-3 text-left"
                    role="checkbox"
                    aria-checked={isPicked}
                    onclick={(e) => togglePick(u.pubkey, e)}
                    data-testid="user-pick"
                  >
                    <span class={cn('flex size-5 shrink-0 items-center justify-center rounded border', isPicked && 'border-primary bg-primary text-primary-foreground')}>
                      {#if isPicked}<Check class="size-3.5" />{/if}
                    </span>
                    {@render body()}
                  </button>
                  {@render detail()}
                </div>
              {:else}
                <SwipeRow
                  testid="user-row"
                  left={[{ id: 'inspect', label: m.people_inspect(), tone: 'neutral', run: () => (selected = u) }]}
                  right={canModerate
                    ? [
                        { id: 'tier', label: m.people_tier(), tone: 'accent', run: () => start('users.set-tier', { pubkey: u.pubkey, tier: null }, true) },
                        { id: 'mute', label: m.people_mute(), tone: 'warn', run: () => runNow('moderation.mute-pubkey', { pubkeys: [u.pubkey] }, { afterUndo: load }) },
                        { id: 'ban', label: m.people_ban(), tone: 'critical', run: () => runNow('moderation.ban-pubkey', { pubkeys: [u.pubkey] }, { afterUndo: load }) },
                      ]
                    : []}
                >
                  <div class="flex items-center">
                    {#if canBulk}
                      <button
                        type="button"
                        class="hidden items-center self-stretch pl-3 md:flex"
                        role="checkbox"
                        aria-checked="false"
                        aria-label={m.common_select()}
                        onclick={() => startSelect(u.pubkey)}
                        data-testid="user-check"
                      >
                        <span class="flex size-5 items-center justify-center rounded border"></span>
                      </button>
                    {/if}
                    <button
                      class="flex min-w-0 flex-1 items-center gap-3 p-3 text-left"
                      use:longpress={{ onpress: () => startSelect(u.pubkey) }}
                      onclick={() => (selected = u)}
                    >
                      {@render body()}
                    </button>
                  </div>
                  {@render detail()}
                </SwipeRow>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-center text-[11px] text-muted-foreground md:hidden">{m.people_swipe_hint()}</p>
        {#if canBulk && !selecting}<p class="mt-1 text-center text-[11px] text-muted-foreground">{m.ppl_select_hint()}</p>{/if}
      {/if}
    </PullToRefresh>
  {/if}

  {#each sectionLinks as r (r.path)}
    <a class="mt-4 block text-sm text-primary" href={to(`/m${r.path}`)}>{r.title}</a>
  {/each}
</div>

{#if tab === 'users' && selecting && picked.size}
  <div class="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4 md:bottom-6">
    <div class="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-xl" data-testid="bulk-bar">
      <span class="text-sm" data-testid="bulk-count">{m.ppl_selected({ count: picked.size })}</span>
      {#if canModerate && app.hasAction('moderation.ban-pubkey')}
        <Button size="sm" variant="destructive" onclick={() => bulk('ban')} data-testid="bulk-ban">{m.people_ban()}</Button>
      {/if}
      {#if canModerate && app.hasAction('moderation.mute-pubkey')}
        <Button size="sm" variant="secondary" onclick={() => bulk('mute')} data-testid="bulk-mute">{m.people_mute()}</Button>
      {/if}
      {#if canUsers && app.hasAction('users.set-tier')}
        <Button size="sm" variant="secondary" onclick={() => bulk('tier')} data-testid="bulk-tier">{m.people_tier()}</Button>
      {/if}
      {#if showUnallow}
        <Button size="sm" variant="secondary" onclick={() => bulk('unallow')} data-testid="bulk-unallow">{m.ppl_unallow()}</Button>
      {/if}
    </div>
  </div>
{/if}

<BulkSheet bind:kind={bulkKind} pubkeys={bulkKeys} tiers={relayCfg?.tiers ?? []} onapplied={afterBulk} onundone={load} />
<UserSheet bind:user={selected} {accessMode} onchange={load} />
