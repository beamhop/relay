<script lang="ts">
  /** Help when lost (§6.10): guided playbooks with one-tap steps. */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { app } from '$lib/stores/app.svelte';
  import { flow } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { to } from '$lib/nav';
  import Button from '$lib/components/ui/button.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type Book = { id: string; title: string; steps: number };
  type Full = { id: string; title: string; steps: Array<{ title: string; body: string; actionId?: string; input?: unknown }> };

  let books = $state<Book[] | null>(null);
  let current = $state<Full | null>(null);
  const selectedId = $derived(page.url.searchParams.get('playbook'));

  onMount(async () => {
    books = await app.api.playbooks().catch(() => []);
  });

  $effect(() => {
    const id = selectedId;
    if (id && current?.id !== id) {
      current = null;
      void app.api.playbook(id).then((p) => (current = p)).catch(() => (current = null));
    }
  });

  function runStep(s: Full['steps'][number]) {
    const def = s.actionId ? app.action(s.actionId) : undefined;
    if (def) void flow.start(def, (s.input ?? {}) as Record<string, unknown>, { form: !s.input });
  }
</script>

<svelte:head><title>{m.help_title()} · {m.app_name()}</title></svelte:head>

{#if selectedId}
  <a href={to('/help')} class="text-sm text-muted-foreground">← {m.help_title()}</a>
  {#if !current}
    <Skeleton class="mt-4 h-40 w-full" />
  {:else}
    <h1 class="mt-2 text-xl font-semibold tracking-tight">{current.title}</h1>
    <ol class="mt-4 space-y-3" data-testid="playbook-steps">
      {#each current.steps as s, i (i)}
        <li class="rounded-xl border p-4">
          <p class="text-xs text-muted-foreground">{m.help_step({ n: i + 1, total: current.steps.length })}</p>
          <h2 class="mt-1 text-sm font-medium">{s.title}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{s.body}</p>
          {#if s.actionId && app.hasAction(s.actionId)}
            <Button size="sm" class="mt-3" onclick={() => runStep(s)}>{app.action(s.actionId)?.title}</Button>
            {#if prefs.lens}<p class="mt-1 font-mono text-[10px] text-muted-foreground">{s.actionId}</p>{/if}
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
{:else}
  <h1 class="text-xl font-semibold tracking-tight">{m.help_title()}</h1>
  <p class="mt-1 text-sm text-muted-foreground">{m.help_desc()}</p>
  {#if books === null}
    <Skeleton class="mt-4 h-32 w-full" />
  {:else if books.length === 0}
    <p class="mt-4 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{m.help_empty()}</p>
  {:else}
    <ul class="mt-4 divide-y rounded-xl border">
      {#each books as b (b.id)}
        <li>
          <a href={to(`/help?playbook=${b.id}`)} class="flex items-center gap-3 p-3.5 hover:bg-muted/40">
            <BookOpen class="size-4 text-muted-foreground" />
            <span class="flex-1 text-sm">{b.title}</span>
            <span class="text-xs text-muted-foreground">{m.help_steps({ count: b.steps })}</span>
            <ChevronRight class="size-4 text-muted-foreground" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="mt-6 text-xs text-muted-foreground">{m.help_shortcuts()}</p>
{/if}
