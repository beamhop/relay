<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Phone: bottom tab bar. Desktop: sidebar. Same five destinations (§6.1). */
  import { page } from '$app/state';
  import House from '@lucide/svelte/icons/house';
  import Activity from '@lucide/svelte/icons/activity';
  import Users from '@lucide/svelte/icons/users';
  import Image from '@lucide/svelte/icons/image';
  import Settings from '@lucide/svelte/icons/settings';
  import { local, to } from '$lib/nav';
  import { cn } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import { haptic } from '$lib/haptics';

  let { badges = {}, variant = 'bar' }: { badges?: Record<string, number>; variant?: 'bar' | 'side' } = $props();

  const tabs = $derived([
    { href: '/', label: m.nav_home(), icon: House, key: 'home' },
    { href: '/activity', label: m.nav_activity(), icon: Activity, key: 'activity' },
    { href: '/people', label: m.nav_people(), icon: Users, key: 'people' },
    { href: '/media', label: m.nav_media(), icon: Image, key: 'media' },
    { href: '/settings', label: m.nav_settings(), icon: Settings, key: 'settings' },
  ]);

  const current = $derived(local(page.url.pathname));
  const active = (href: string) => (href === '/' ? current === '/' : current.startsWith(href));
</script>

{#if variant === 'bar'}
<nav
  aria-label={m.nav_main()}
  class="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-safe backdrop-blur-xl md:hidden"
  data-testid="tab-bar"
>
  <ul class="grid grid-cols-5">
    {#each tabs as t (t.href)}
      {@const Icon = t.icon}
      <li>
        <a
          href={to(t.href)}
          onclick={() => haptic('tap')}
          aria-current={active(t.href) ? 'page' : undefined}
          class={cn(
            'relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors',
            active(t.href) ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          <Icon class="size-5" strokeWidth={active(t.href) ? 2.4 : 1.8} />
          {t.label}
          {#if badges[t.key]}
            <span class="absolute top-2 left-1/2 ml-2 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">
              {badges[t.key]}
            </span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
{:else}
<nav aria-label={m.nav_main()} data-testid="sidebar">
  <ul class="space-y-0.5">
    {#each tabs as t (t.href)}
      {@const Icon = t.icon}
      <li>
        <a
          href={to(t.href)}
          aria-current={active(t.href) ? 'page' : undefined}
          class={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
            active(t.href) ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <Icon class="size-4" />
          <span class="flex-1">{t.label}</span>
          {#if badges[t.key]}
            <span class="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">{badges[t.key]}</span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
{/if}
