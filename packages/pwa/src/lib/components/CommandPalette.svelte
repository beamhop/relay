<script lang="ts">
  /** ⌘K command palette (§6.13): jump anywhere, run any action from the catalog. */
  import { Command } from 'bits-ui';
  import { goto } from '$app/navigation';
  import { fade, scale } from 'svelte/transition';
  import Search from '@lucide/svelte/icons/search';
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
  import { app } from '$lib/stores/app.svelte';
  import { flow } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { to } from '$lib/nav';
  import type { CatalogAction } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let search = $state('');

  const pages = $derived([
    { id: 'go-home', label: m.nav_home(), href: '/' },
    { id: 'go-activity', label: m.nav_activity(), href: '/activity' },
    { id: 'go-queue', label: m.activity_tab_queue(), href: '/activity?tab=queue' },
    { id: 'go-people', label: m.nav_people(), href: '/people' },
    { id: 'go-media', label: m.nav_media(), href: '/media' },
    { id: 'go-settings', label: m.nav_settings(), href: '/settings' },
    { id: 'go-goals', label: m.settings_goals_title(), href: '/settings/goals' },
    { id: 'go-history', label: m.history_title(), href: '/settings/history' },
    { id: 'go-help', label: m.help_title(), href: '/help' },
  ]);

  const actions = $derived(
    [...app.catalog].sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.title.localeCompare(b.title)),
  );

  function hasInputs(a: CatalogAction): boolean {
    return Object.keys(a.inputSchema?.properties ?? {}).length > 0;
  }

  function close() {
    open = false;
    search = '';
  }

  function runAction(a: CatalogAction) {
    close();
    void flow.start(a, {}, { form: hasInputs(a) });
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open = !open;
    } else if (open && e.key === 'Escape') {
      close();
    }
  }
</script>

<svelte:window {onkeydown} />

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
      <Command.Root class="flex max-h-[70dvh] flex-col" loop>
        <div class="flex items-center gap-2 border-b px-3">
          <Search class="size-4 text-muted-foreground" />
          <!-- svelte-ignore a11y_autofocus -->
          <Command.Input
            bind:value={search}
            autofocus
            placeholder={m.palette_placeholder()}
            class="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd class="hidden rounded border px-1.5 text-[10px] text-muted-foreground md:block">esc</kbd>
        </div>
        <Command.List class="overflow-y-auto p-2">
          <Command.Empty class="px-3 py-6 text-center text-sm text-muted-foreground">{m.palette_empty()}</Command.Empty>
          <Command.Group>
            <Command.GroupHeading class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {m.palette_go_to()}
            </Command.GroupHeading>
            <Command.GroupItems>
              {#each pages as p (p.id)}
                <Command.Item
                  value={p.id}
                  keywords={[p.label]}
                  onSelect={() => {
                    close();
                    void goto(to(p.href));
                  }}
                  class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm data-selected:bg-muted"
                >
                  {p.label}
                </Command.Item>
              {/each}
              <Command.Item
                value="toggle-lens"
                keywords={['technical', 'lens', 'nip', 'details', 'advanced']}
                onSelect={() => {
                  prefs.toggleLens();
                  close();
                }}
                class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm data-selected:bg-muted"
              >
                {prefs.lens ? m.lens_hide() : m.lens_show()}
              </Command.Item>
            </Command.GroupItems>
          </Command.Group>
          {#if actions.length}
            <Command.Group>
              <Command.GroupHeading class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {m.palette_actions()}
              </Command.GroupHeading>
              <Command.GroupItems>
                {#each actions as a (a.id)}
                  <Command.Item
                    value={a.id}
                    keywords={[a.title, a.description, ...a.keywords]}
                    disabled={!a.allowed}
                    onSelect={() => runAction(a)}
                    class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm data-disabled:opacity-40 data-selected:bg-muted"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="truncate">{a.title}</p>
                      <p class="truncate text-xs text-muted-foreground">
                        {prefs.lens ? a.id : a.description}
                      </p>
                    </div>
                    {#if a.shortcut}<kbd class="rounded border px-1.5 text-[10px] text-muted-foreground">{a.shortcut}</kbd>{/if}
                    <CornerDownLeft class="size-3.5 text-muted-foreground opacity-0 group-data-selected:opacity-100" />
                  </Command.Item>
                {/each}
              </Command.GroupItems>
            </Command.Group>
          {/if}
        </Command.List>
      </Command.Root>
    </div>
  </div>
{/if}
