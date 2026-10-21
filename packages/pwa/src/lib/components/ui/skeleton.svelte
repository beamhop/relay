<script lang="ts">
  import { cn } from '$lib/utils';
  let { class: klass = '' }: { class?: string } = $props();
</script>

<div aria-hidden="true" data-skeleton class={cn('animate-[shimmer_1.6s_ease-in-out_infinite] rounded-lg bg-muted', klass)}></div>
