<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import Sheet from '../Sheet.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const keys = $derived([
    ['⌘ K', m.kbd_palette()],
    ['g h / g a / g p / g m / g s', m.kbd_goto()],
    ['j / k', m.kbd_next_prev()],
    ['e', m.kbd_keep()],
    ['x', m.kbd_remove()],
    ['#', m.kbd_ban()],
    ['s', m.kbd_skip()],
    ['u', m.kbd_undo()],
    ['t', m.kbd_lens()],
    ['?', m.kbd_help()],
  ]);
</script>

<Sheet bind:open title={m.kbd_title()} testid="keyboard-help">
  <dl class="divide-y text-sm">
    {#each keys as [k, label] (k)}
      <div class="flex items-center justify-between py-2">
        <dt class="text-muted-foreground">{label}</dt>
        <dd><kbd class="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dd>
      </div>
    {/each}
  </dl>
</Sheet>
