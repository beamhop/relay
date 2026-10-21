<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Detail sheet of one file: preview, who/when, storage tier, technical lens, team notes, delete. */
  import FileIcon from '@lucide/svelte/icons/file';
  import Sheet from '$lib/components/Sheet.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { names } from '$lib/stores/names.svelte';
  import { ago, formatBytes } from '$lib/utils';
  import { m } from '$lib/paraglide/messages.js';
  import FileNotes from './FileNotes.svelte';
  import { type MediaFile, fileLensLines } from './media';

  let {
    file = $bindable(null),
    ondelete,
  }: { file?: MediaFile | null; ondelete?: (f: MediaFile) => void } = $props();

  let open = $state(false);
  $effect(() => {
    open = !!file;
  });

  const isImage = $derived(!!file?.type?.startsWith('image/') && !file?.quarantined);
  const src = $derived(file ? (file.thumbUrl ?? file.url ?? `/${file.sha256}`) : '');
  const href = $derived(file ? (file.url ?? `/${file.sha256}`) : '');
</script>

<Sheet bind:open title={m.media_file_details()} onclose={() => (file = null)} testid="file-sheet">
  {#if file}
    <div class="space-y-4">
      <div class="flex gap-3">
        <div class="size-24 shrink-0 overflow-hidden rounded-lg border bg-muted">
          {#if isImage}
            <img {src} alt="" class="h-full w-full object-cover" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
          {:else}
            <span class="flex h-full w-full items-center justify-center text-muted-foreground"><FileIcon class="size-6" /></span>
          {/if}
        </div>
        <div class="min-w-0 flex-1 text-sm">
          <p class="truncate">{file.type ?? m.media_file()} · {formatBytes(file.size)}</p>
          <p class="text-xs text-muted-foreground">
            {m.media_file_uploaded({ when: file.uploadedAt ? ago(file.uploadedAt) : '—', name: names.label(file.pubkey) })}
          </p>
          <div class="mt-1 flex flex-wrap gap-1">
            {#if file.tier === 'cold'}<Badge tone="neutral">{m.media_file_tier_cold()}</Badge>{/if}
            {#if file.quarantined}<Badge tone="critical">{m.media_quarantined()}</Badge>{/if}
          </div>
          {#if !file.quarantined}
            <a {href} target="_blank" rel="noopener noreferrer" class="mt-1 inline-block text-xs text-primary">{m.media_file_open()}</a>
          {/if}
        </div>
      </div>
      <div data-testid="file-lens"><ItemLens lines={fileLensLines(file)} /></div>
      <FileNotes sha256={file.sha256} />
      {#if ondelete && app.can('media.write')}
        <Button variant="destructive" size="sm" class="w-full" onclick={() => file && ondelete?.(file)} data-testid="file-delete">{m.common_delete()}</Button>
      {/if}
    </div>
  {/if}
</Sheet>
