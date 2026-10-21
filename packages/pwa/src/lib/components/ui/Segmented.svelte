<script lang="ts">
  /** Segmented tabs bound to the `?tab=` query parameter (deep-linkable, back-button friendly). */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { cn } from '$lib/utils';

  let {
    tabs,
    label,
    param = 'tab',
  }: { tabs: Array<{ id: string; label: string; count?: number }>; label: string; param?: string } = $props();

  const current = $derived(page.url.searchParams.get(param) ?? tabs[0]?.id);

  function select(id: string) {
    const url = new URL(page.url);
    url.searchParams.set(param, id);
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }
</script>

<div role="tablist" aria-label={label} class="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
  {#each tabs as t (t.id)}
    <button
      role="tab"
      aria-selected={current === t.id}
      data-testid={`tab-${t.id}`}
      class={cn(
        'shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors',
        current === t.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
      )}
      onclick={() => select(t.id)}
    >
      {t.label}
      {#if t.count}<span class="ml-1 text-xs opacity-70">{t.count}</span>{/if}
    </button>
  {/each}
</div>
