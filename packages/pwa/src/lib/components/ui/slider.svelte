<script lang="ts">
  import { Slider } from 'bits-ui';
  import { cn } from '$lib/utils';

  let {
    value = $bindable(50),
    min = 0,
    max = 100,
    step = 1,
    label,
    disabled = false,
    class: klass = '',
    onValueCommit,
    ...rest
  }: {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    disabled?: boolean;
    class?: string;
    onValueCommit?: (v: number) => void;
    [key: string]: unknown;
  } = $props();
</script>

<Slider.Root
  type="single"
  bind:value
  {min}
  {max}
  {step}
  {disabled}
  {onValueCommit}
  class={cn('relative flex h-8 w-full touch-none select-none items-center', klass)}
  {...rest}
>
  <span class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
    <Slider.Range class="absolute h-full bg-primary" />
  </span>
  <Slider.Thumb
    index={0}
    aria-label={label}
    class="block size-6 rounded-full border-2 border-primary bg-background shadow transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-110"
  />
</Slider.Root>
