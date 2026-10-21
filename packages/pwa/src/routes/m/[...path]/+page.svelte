<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Screens contributed by enabled modules (`/ui` manifest). Chunks are
   * code-split and only downloaded when the module is enabled and the screen
   * is opened (enterprise invisible rule, §12.0). Nothing is shown otherwise.
   */
  import type { Component } from 'svelte';
  import { page } from '$app/state';
  import { app } from '$lib/stores/app.svelte';
  import { moduleChunk } from '$lib/modules';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const path = $derived(`/${page.params.path ?? ''}`.replace(/\/+$/, '') || '/');
  /** Exact screen, else the longest module path this one is below (`/approvals/<id>`). */
  const route = $derived(
    app.uiRoutes.find((r) => r.path === path) ??
      app.uiRoutes
        .filter((r) => path.startsWith(`${r.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0],
  );
  /** What follows the module path (e.g. a request id), without the leading slash. */
  const sub = $derived(route && path !== route.path ? path.slice(route.path.length + 1) : '');
  let Screen = $state<Component<{ path: string; sub: string }> | null>(null);
  let error = $state<unknown>(null);
  let missing = $state(false);

  $effect(() => {
    const r = route;
    Screen = null;
    missing = false;
    error = null;
    if (!r) return;
    const load = moduleChunk(r.chunk);
    if (!load) {
      missing = true;
      return;
    }
    load()
      .then((mod) => (Screen = mod.default as Component<{ path: string; sub: string }>))
      .catch((err) => (error = err));
  });
</script>

{#if !route || missing}
  <p class="text-sm text-muted-foreground" data-testid="module-missing">{m.module_unavailable()}</p>
{:else if error}
  <ErrorPanel {error} />
{:else if Screen}
  <h1 class="mb-4 text-xl font-semibold tracking-tight">{route.title}</h1>
  <Screen path={route.path} {sub} />
{:else}
  <Skeleton class="h-40 w-full" />
{/if}
