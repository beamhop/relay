<script lang="ts">
  import { renderSVG } from 'uqr';

  let { value, label, size = 176 }: { value: string; label: string; size?: number } = $props();
  const svg = $derived(renderSVG(value, { border: 2, whiteColor: '#ffffff', blackColor: '#09090b' }));
</script>

<div
  class="overflow-hidden rounded-xl bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
  style:width={`${size}px`}
  style:height={`${size}px`}
  role="img"
  aria-label={label}
  data-testid="qr"
>
  {@html svg}
</div>
