<script lang="ts">
  /**
   * ⌘K command palette (§6.13): jump anywhere, run any action from the
   * catalog. Recent and suggested entries first, then screens and action
   * groups, each with an icon. Action ids only under the technical lens.
   */
  import { Command } from 'bits-ui';
  import type { Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { fade, scale } from 'svelte/transition';
  import Search from '@lucide/svelte/icons/search';
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
  import House from '@lucide/svelte/icons/house';
  import Activity from '@lucide/svelte/icons/activity';
  import Users from '@lucide/svelte/icons/users';
  import Image from '@lucide/svelte/icons/image';
  import Settings from '@lucide/svelte/icons/settings';
  import History from '@lucide/svelte/icons/history';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Shield from '@lucide/svelte/icons/shield';
  import Database from '@lucide/svelte/icons/database';
  import Bell from '@lucide/svelte/icons/bell';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Building2 from '@lucide/svelte/icons/building-2';
  import Gauge from '@lucide/svelte/icons/gauge';
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Code from '@lucide/svelte/icons/code';
  import Clock from '@lucide/svelte/icons/clock';
  import Star from '@lucide/svelte/icons/star';
  import Compass from '@lucide/svelte/icons/compass';
  import ChartLine from '@lucide/svelte/icons/chart-line';
  import Zap from '@lucide/svelte/icons/zap';
  import { app } from '$lib/stores/app.svelte';
  import { flow } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { to } from '$lib/nav';
  import { GROUP_ORDER, actionGroup, pushRecent, recentKeys, score, suggestions, type GroupId } from '$lib/palette';
  import type { CatalogAction } from '$lib/api/types';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false), onassistant }: { open?: boolean; onassistant?: () => void } = $props();
  let search = $state('');
  let recent = $state<string[]>([]);

  $effect(() => {
    if (open) recent = recentKeys();
  });

  interface Entry {
    key: string;
    label: string;
    sub?: string;
    icon: Component;
    keywords: string[];
    disabled?: boolean;
    shortcut?: string;
    run: () => void;
  }

  const GROUPS: Record<GroupId, { label: () => string; icon: Component }> = {
    home: { label: () => m.palette_group_home(), icon: House },
    moderation: { label: () => m.palette_group_moderation(), icon: Shield },
    people: { label: () => m.palette_group_people(), icon: Users },
    media: { label: () => m.palette_group_media(), icon: Image },
    settings: { label: () => m.palette_group_settings(), icon: Settings },
    alerts: { label: () => m.palette_group_alerts(), icon: Bell },
    backups: { label: () => m.palette_group_backups(), icon: Database },
    plugins: { label: () => m.palette_group_plugins(), icon: Puzzle },
    company: { label: () => m.palette_group_company(), icon: Building2 },
    assistant: { label: () => m.palette_group_assistant(), icon: Sparkles },
    insights: { label: () => m.palette_group_insights(), icon: ChartLine },
    security: { label: () => m.palette_group_security(), icon: KeyRound },
    history: { label: () => m.palette_group_history(), icon: History },
    other: { label: () => m.palette_actions(), icon: Zap },
  };

  function page(href: string, label: string, icon: Component, keywords: string[] = []): Entry {
    return {
      key: `page:${href}`,
      label,
      icon,
      keywords: [label, ...keywords],
      run: () => void goto(to(href)),
    };
  }

  const companyOn = $derived(
    app.hasAction('enterprise.connect-idp') || app.uiRoutes.some((r) => r.path === '/settings/company'),
  );

  const pages = $derived<Entry[]>([
    page('/', m.nav_home(), House, ['home', 'dashboard']),
    page('/activity', m.nav_activity(), Activity, ['activity', 'feed', 'log']),
    page('/activity?tab=queue', m.activity_tab_queue(), Shield, ['moderation', 'reports', 'queue']),
    page('/people', m.nav_people(), Users, ['users', 'people', 'members']),
    page('/media', m.nav_media(), Image, ['files', 'media', 'uploads']),
    page('/settings', m.nav_settings(), Settings, ['settings', 'config']),
    page('/settings/goals', m.settings_goals_title(), Gauge, ['goals', 'limits']),
    page('/settings/backups', m.palette_page_backups(), Database, ['backups']),
    page('/settings/alerts', m.palette_page_alerts(), Bell, ['alerts', 'notifications']),
    page('/settings/plugins', m.settings_plugins_title(), Puzzle, ['plugins', 'extensions']),
    page('/settings/security', m.security_title(), KeyRound, ['security', 'passkey', 'recovery']),
    ...(companyOn ? [page('/settings/company', m.company_title(), Building2, ['sso', 'company', 'scim'])] : []),
    page('/settings/history', m.history_title(), History, ['history', 'revisions', 'undo']),
    page('/help', m.help_title(), LifeBuoy, ['help', 'guide']),
  ]);

  const tools = $derived<Entry[]>([
    {
      key: 'tool:lens',
      label: prefs.lens ? m.lens_hide() : m.lens_show(),
      icon: Code,
      keywords: [prefs.lens ? m.lens_hide() : m.lens_show(), 'technical', 'lens', 'nip', 'details', 'advanced'],
      run: () => prefs.toggleLens(),
    },
    ...(onassistant
      ? [
          {
            key: 'tool:assistant',
            label: m.assistant_open(),
            icon: Sparkles,
            keywords: [m.assistant_open(), 'ai', 'assistant', 'chat', 'ask', 'help'],
            run: () => onassistant(),
          },
        ]
      : []),
  ]);

  function hasInputs(a: CatalogAction): boolean {
    return Object.keys(a.inputSchema?.properties ?? {}).length > 0;
  }

  const actionEntries = $derived(
    [...app.catalog]
      .sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.title.localeCompare(b.title))
      .map(
        (a): Entry & { group: GroupId } => ({
          key: `action:${a.id}`,
          label: a.title,
          sub: prefs.lens ? a.id : a.description,
          group: actionGroup(a.id),
          icon: GROUPS[actionGroup(a.id)].icon,
          keywords: [a.title, a.description, ...a.keywords, ...(prefs.lens ? [a.id] : [])],
          disabled: !a.allowed,
          ...(a.shortcut ? { shortcut: a.shortcut } : {}),
          run: () => void flow.start(a, {}, { form: hasInputs(a) }),
        }),
      ),
  );

  const groups = $derived(
    GROUP_ORDER.map((g) => ({ id: g, ...GROUPS[g], items: actionEntries.filter((e) => e.group === g) })).filter(
      (g) => g.items.length,
    ),
  );

  const byKey = $derived(new Map<string, Entry>([...pages, ...tools, ...actionEntries].map((e) => [e.key, e])));
  const recentEntries = $derived(recent.map((k) => byKey.get(k)).filter((e): e is Entry => !!e && !e.disabled));
  const suggestedEntries = $derived(
    suggestions(new Set(byKey.keys()), recent)
      .map((k) => byKey.get(k))
      .filter((e): e is Entry => !!e && !e.disabled),
  );
  const browsing = $derived(!search.trim());

  function close() {
    open = false;
    search = '';
  }

  function select(e: Entry) {
    recent = pushRecent(e.key, recent);
    close();
    e.run();
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open = !open;
    } else if (open && e.key === 'Escape') {
      close();
    }
  }

  const itemClass =
    'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm data-disabled:cursor-not-allowed data-disabled:opacity-40 data-selected:bg-muted';
  const headingClass = 'flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
</script>

<svelte:window {onkeydown} />

{#snippet item(e: Entry, prefix = '')}
  {@const Icon = e.icon}
  <Command.Item
    value={`${prefix}${e.key}`}
    keywords={e.keywords}
    disabled={e.disabled}
    onSelect={() => select(e)}
    class={itemClass}
    data-entry={e.key}
  >
    <Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="truncate leading-5">{e.label}</p>
      {#if e.sub}
        <p class={cn('truncate text-xs leading-4 text-muted-foreground', prefs.lens && e.key.startsWith('action:') && 'font-mono')} data-lens={prefs.lens && e.key.startsWith('action:') ? '' : undefined}>
          {e.sub}
        </p>
      {/if}
    </div>
    {#if e.shortcut}<kbd class="rounded border px-1.5 text-[10px] text-muted-foreground">{e.shortcut}</kbd>{/if}
    <CornerDownLeft class="size-3.5 text-muted-foreground opacity-0 [[data-selected]_&]:opacity-100" aria-hidden="true" />
  </Command.Item>
{/snippet}

{#snippet group(label: string, Icon: Component, entries: Entry[], prefix = '', testid = '')}
  <Command.Group data-testid={testid || undefined}>
    <Command.GroupHeading class={headingClass}>
      <Icon class="size-3.5" aria-hidden="true" />{label}
    </Command.GroupHeading>
    <Command.GroupItems>
      {#each entries as e (e.key)}
        {@render item(e, prefix)}
      {/each}
    </Command.GroupItems>
  </Command.Group>
{/snippet}

{#if open}
  <div class="fixed inset-0 z-[55] flex items-start justify-center p-3 pt-[10dvh]">
    <button
      type="button"
      tabindex="-1"
      aria-label={m.common_close()}
      class="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[2px]"
      onclick={close}
      transition:fade={{ duration: 120 }}
    ></button>
    <div
      class="relative w-full max-w-xl overflow-hidden rounded-2xl border bg-card shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label={m.palette_title()}
      data-testid="command-palette"
      transition:scale={{ start: 0.97, duration: 140 }}
    >
      <Command.Root class="flex max-h-[70dvh] flex-col" loop filter={(_v, s, k) => score(s, k)}>
        <div class="flex items-center gap-2 border-b px-3">
          <Search class="size-4 text-muted-foreground" />
          <!-- svelte-ignore a11y_autofocus -->
          <Command.Input
            bind:value={search}
            autofocus
            placeholder={m.palette_placeholder()}
            class="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd class="hidden rounded border px-1.5 text-[10px] text-muted-foreground md:block">esc</kbd>
        </div>
        <Command.List class="overflow-y-auto px-1.5 pb-1.5">
          <Command.Empty class="px-3 py-6 text-center text-sm text-muted-foreground">{m.palette_empty()}</Command.Empty>
          {#if browsing && recentEntries.length}
            {@render group(m.palette_recent(), Clock, recentEntries, 'recent:', 'palette-recent')}
          {/if}
          {#if browsing && suggestedEntries.length}
            {@render group(m.palette_suggested(), Star, suggestedEntries, 'suggested:', 'palette-suggested')}
          {/if}
          {@render group(m.palette_go_to(), Compass, [...pages, ...tools])}
          {#each groups as g (g.id)}
            {@render group(g.label(), g.icon, g.items, '', `palette-group-${g.id}`)}
          {/each}
        </Command.List>
      </Command.Root>
    </div>
  </div>
{/if}
