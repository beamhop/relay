<script lang="ts">
  /**
   * Unknown screens (old bookmarks, links from the server or a module that is
   * off) never dead-end: go to the nearest tab and say so (§6.10).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { local, to } from '$lib/nav';
  import { resolveScreen } from '$lib/screens';
  import { announceFallback } from '$lib/fallback';
  import { app } from '$lib/stores/app.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const notFound = $derived(page.status === 404);

  onMount(() => {
    if (page.status !== 404) return;
    const target = resolveScreen(
      local(page.url.pathname) + page.url.search,
      app.uiRoutes.map((r) => r.path),
    );
    if (target.fallback) announceFallback(target.tab);
    void goto(to(target.href), { replaceState: true });
  });
</script>

{#if notFound}
  <p class="py-10 text-center text-sm text-muted-foreground" data-testid="screen-redirect">{m.common_working()}</p>
{:else}
  <ErrorPanel error={page.error} reset={() => location.reload()} />
{/if}
