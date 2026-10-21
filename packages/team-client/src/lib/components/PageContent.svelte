<script lang="ts">
  import cx from "classnames"
  import type {Snippet} from "svelte"

  type Props = {
    element?: Element
    children?: Snippet
    noPad?: boolean
    [key: string]: any
  }

  let {children, element = $bindable(), noPad, ...props}: Props = $props()

  const className = $derived(
    cx("page__content scroll-container", props.class, {"page__content--no-pad": noPad}),
  )
</script>

<div {...props} bind:this={element} data-component="PageContent" class={className}>
  {@render children?.()}
</div>
