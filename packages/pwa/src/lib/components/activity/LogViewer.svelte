<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Errors & logs (§6.1, §8): recent server log lines (`logs.query`) with
   * filters for level, part of the server, text and time, plus a live tail
   * (polls every 3 s while open). IP addresses arrive already hashed and
   * secrets hidden; each line opens into its structured fields.
   */
  import { onDestroy, onMount } from 'svelte';
  import Play from '@lucide/svelte/icons/play';
  import Pause from '@lucide/svelte/icons/pause';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError } from '$lib/stores/actions.svelte';
  import { cn } from '$lib/utils';
  import Skeleton from '../ui/skeleton.svelte';
  import { LOG_RANGES, type LogRangeId, fieldLines, mergeLogs, sinceFor } from './alerts';
  import { m } from '$lib/paraglide/messages.js';

  type Level = 'debug' | 'info' | 'warn' | 'error';
  interface LogLine {
    at: number;
    level: Level;
    source: string;
    message: string;
    fields: Record<string, unknown>;
  }

  const LEVELS: Level[] = ['error', 'warn', 'info', 'debug'];
  const POLL_MS = 3000;

  let levels = $state<Set<Level>>(new Set(['error', 'warn']));
  let source = $state('');
  let text = $state('');
  let range = $state<LogRangeId>('1h');
  let tail = $state(false);
  let lines = $state<LogLine[] | null>(null);
  let sources = $state<string[]>([]);
  let dropped = $state(0);
  let error = $state<string | null>(null);
  let open = $state<Set<string>>(new Set());
  let timer: ReturnType<typeof setInterval> | null = null;

  const available = $derived(app.hasAction('logs.query'));

  function input(since?: number): Record<string, unknown> {
    const i: Record<string, unknown> = { level: [...levels], limit: 300 };
    if (source) i.source = source;
    if (text.trim()) i.text = text.trim();
    const s = since ?? sinceFor(range, Date.now());
    if (s !== undefined) i.since = s;
    return i;
  }

  async function load() {
    if (!available) return;
    try {
      const def = app.action('logs.query');
      const r = await app.api.run<{ records: LogLine[]; dropped: number; sources?: string[] }>('logs.query', input(), def?.scope ?? 'node');
      lines = r.output.records;
      dropped = r.output.dropped;
      if (r.output.sources) sources = r.output.sources;
      error = null;
    } catch (err) {
      error = asApiError(err).message;
      lines ??= [];
    }
  }

  async function poll() {
    if (!lines) return load();
    const newest = lines[0]?.at;
    try {
      const def = app.action('logs.query');
      const r = await app.api.run<{ records: LogLine[]; dropped: number }>(
        'logs.query',
        input(newest !== undefined ? newest : undefined),
        def?.scope ?? 'node',
      );
      lines = mergeLogs(lines, r.output.records);
      dropped = r.output.dropped;
    } catch {
      // keep what we have; the next poll retries
    }
  }

  onMount(load);
  onDestroy(() => timer && clearInterval(timer));

  $effect(() => {
    if (timer) clearInterval(timer);
    timer = tail ? setInterval(() => void poll(), POLL_MS) : null;
  });

  let debounce: ReturnType<typeof setTimeout> | null = null;
  function refilter() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void load(), 250);
  }

  function toggleLevel(l: Level) {
    const s = new Set(levels);
    if (s.has(l)) s.delete(l);
    else s.add(l);
    if (s.size === 0) return;
    levels = s;
    void load();
  }

  const id = (l: LogLine, i: number) => `${l.at}-${i}`;
  function toggleOpen(k: string) {
    const s = new Set(open);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    open = s;
  }

  const levelText: Record<Level, () => string> = {
    error: () => m.act_logs_error(),
    warn: () => m.act_logs_warn(),
    info: () => m.act_logs_info(),
    debug: () => m.act_logs_debug(),
  };
  const levelDot: Record<Level, string> = {
    error: 'bg-destructive',
    warn: 'bg-warning',
    info: 'bg-primary',
    debug: 'bg-muted-foreground/50',
  };
  const rangeText: Record<LogRangeId, () => string> = {
    '15m': () => m.act_logs_15m(),
    '1h': () => m.act_logs_1h(),
    '24h': () => m.act_logs_24h(),
    all: () => m.act_logs_all(),
  };
</script>

{#if !available}
  <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="logs-unavailable">{m.act_logs_unavailable()}</p>
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <input
      type="search"
      class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm"
      placeholder={m.act_logs_search()}
      aria-label={m.act_logs_search()}
      bind:value={text}
      oninput={refilter}
      data-testid="logs-search"
    />
    <button
      class={cn('flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm', tail && 'border-foreground')}
      aria-pressed={tail}
      onclick={() => (tail = !tail)}
      data-testid="logs-tail"
    >
      {#if tail}<Pause class="size-3.5" />{:else}<Play class="size-3.5" />{/if}{m.act_logs_tail()}
    </button>
  </div>
  <div class="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={m.act_logs_filters()}>
    {#each LEVELS as l (l)}
      <button
        class={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', levels.has(l) ? 'border-foreground' : 'text-muted-foreground')}
        aria-pressed={levels.has(l)}
        onclick={() => toggleLevel(l)}
        data-testid={`logs-level-${l}`}
      >
        <span class={cn('size-1.5 rounded-full', levelDot[l])}></span>{levelText[l]()}
      </button>
    {/each}
    <select
      class="h-7 rounded-full border bg-background px-2 text-xs"
      aria-label={m.act_logs_source()}
      bind:value={source}
      onchange={() => void load()}
      data-testid="logs-source"
    >
      <option value="">{m.act_logs_source_all()}</option>
      {#each sources as s (s)}<option value={s}>{s}</option>{/each}
    </select>
    <select
      class="h-7 rounded-full border bg-background px-2 text-xs"
      aria-label={m.act_logs_range()}
      bind:value={range}
      onchange={() => void load()}
      data-testid="logs-range"
    >
      {#each LOG_RANGES as r (r.id)}<option value={r.id}>{rangeText[r.id]()}</option>{/each}
    </select>
  </div>
  <p class="mb-2 text-xs text-muted-foreground">{m.act_logs_privacy()}{dropped ? ` ${m.act_logs_dropped({ count: dropped })}` : ''}</p>

  {#if lines === null}
    <Skeleton class="h-40 w-full" />
  {:else if error}
    <p class="text-sm text-destructive">{error}</p>
  {:else if lines.length === 0}
    <p class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="logs-empty">{m.act_logs_empty()}</p>
  {:else}
    <ul class="divide-y rounded-xl border" data-testid="logs-list">
      {#each lines as l, i (id(l, i))}
        {@const k = id(l, i)}
        <li class="px-3 py-2" data-testid="log-line" data-level={l.level}>
          <button type="button" class="flex w-full items-start gap-2 text-left" aria-expanded={open.has(k)} onclick={() => toggleOpen(k)}>
            <ChevronRight class={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform', open.has(k) && 'rotate-90')} />
            <span class={cn('mt-1.5 size-2 shrink-0 rounded-full', levelDot[l.level])} title={levelText[l.level]()}></span>
            <span class="min-w-0 flex-1">
              <span class="block break-words text-sm">{l.message}</span>
              <span class="block text-[11px] text-muted-foreground">{l.source} · {new Date(l.at).toLocaleTimeString()}</span>
            </span>
          </button>
          {#if open.has(k)}
            <div class="ml-9 mt-1" data-testid="log-fields">
              <!-- The expanded line is this item's technical lens (same look as ItemLens). -->
              <div class="rounded-md bg-muted px-2 py-1 font-mono text-[11px] break-all text-muted-foreground" data-testid="item-lens-details">
                {#each [`level ${l.level} · ${new Date(l.at).toISOString()}`, ...fieldLines(l.fields)] as line, j (j)}<div>{line}</div>{/each}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}
