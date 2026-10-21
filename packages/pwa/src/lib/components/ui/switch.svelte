<script lang="ts">
  import { Switch } from 'bits-ui';
  import { cn } from '$lib/utils';

  let {
    checked = $bindable(false),
    id,
    disabled = false,
    label,
    class: klass = '',
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    id?: string;
    disabled?: boolean;
    label?: string;
    class?: string;
    onCheckedChange?: (v: boolean) => void;
    [key: string]: unknown;
  } = $props();
</script>

<Switch.Root
  bind:checked
  {id}
  {disabled}
  aria-label={label}
  {onCheckedChange}
  class={cn(
    'peer inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/30 disabled:opacity-50',
    klass,
  )}
  {...rest}
>
  <Switch.Thumb
    class="pointer-events-none block size-5 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
  />
</Switch.Root>
