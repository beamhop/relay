<script lang="ts">
  import type {Snippet} from "svelte"
  import AltArrowRight from "@assets/icons/alt-arrow-right.svg?dataurl"
  import Icon from "@lib/components/Icon.svelte"

  type Props = {
    icon?: Snippet
    title?: Snippet
    info?: Snippet
    primary?: boolean
  }

  const {icon, title, info, primary}: Props = $props()
</script>

<div class="card-button {primary ? 'card-button-primary' : 'card-button-neutral'}">
  <div class="card-button__left">
    <div class="card-button__icon">
      {@render icon?.()}
    </div>
    <div class="card-button__content">
      <p class="card-button__title">
        {@render title?.()}
      </p>
      <p class="card-button__info">
        {@render info?.()}
      </p>
    </div>
  </div>
  <div class="card-button__right">
    <Icon size={7} icon={AltArrowRight} />
  </div>
</div>
