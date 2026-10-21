<script lang="ts" module>
  import { tv, type VariantProps } from 'tailwind-variants';

  export const buttonVariants = tv({
    base: 'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-foreground hover:bg-muted/70',
        outline: 'border bg-transparent hover:bg-muted',
        ghost: 'hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-12 px-5 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  });

  export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
  export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  type Props = HTMLButtonAttributes &
    Pick<HTMLAnchorAttributes, 'href'> & {
      variant?: ButtonVariant;
      size?: ButtonSize;
      children?: Snippet;
    };

  let { variant, size, class: klass, href, children, type = 'button', ...rest }: Props = $props();
</script>

{#if href}
  <a {href} class={cn(buttonVariants({ variant, size }), klass as string)} {...rest as HTMLAnchorAttributes}>
    {@render children?.()}
  </a>
{:else}
  <button {type} class={cn(buttonVariants({ variant, size }), klass as string)} {...rest}>
    {@render children?.()}
  </button>
{/if}
