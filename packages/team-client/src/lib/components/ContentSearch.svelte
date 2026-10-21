<script lang="ts">
  type Props = {
    input?: import("svelte").Snippet
    content?: import("svelte").Snippet
    [key: string]: any
  }

  const {...props}: Props = $props()
</script>

<div class="content-search {props.class}">
  <div class="z-feature">
    {@render props.input?.()}
  </div>
  <div class="scroll-container h-full pt-2">
    {@render props.content?.()}
  </div>
</div>
