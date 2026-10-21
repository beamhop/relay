<script lang="ts">
  /**
   * GeneratedForm, loaded on first use. The form stack (superforms, formsnap,
   * zod) stays out of the first-load bundle of the app shell.
   */
  import type { ComponentProps } from 'svelte';
  import type GeneratedForm from './GeneratedForm.svelte';
  import Skeleton from '../ui/skeleton.svelte';

  let props: ComponentProps<typeof GeneratedForm> = $props();
  const load = import('./GeneratedForm.svelte');
</script>

{#await load}
  <div class="space-y-3 py-3" aria-busy="true"><Skeleton class="h-10 w-full" /><Skeleton class="h-10 w-full" /></div>
{:then mod}
  {@const Form = mod.default}
  <Form {...props} />
{/await}
