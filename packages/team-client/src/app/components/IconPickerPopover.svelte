<script lang="ts">
  import IconPicker from "@app/components/IconPicker.svelte"

  type Props = {
    onSelect: (iconUrl: string) => void
  }

  const {onSelect}: Props = $props()
</script>

<div class="w-96 rounded-2xl bg-surface p-4 shadow-2xl">
  <IconPicker {onSelect} />
</div>
