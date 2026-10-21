<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Company directory (PLAN §13): people from the IdP, grouped by department, searchable. -->
<script lang="ts">
  import {onMount} from "svelte"
  import UsersGroup from "@assets/icons/users-group-rounded.svg?dataurl"
  import Magnifier from "@assets/icons/magnifier.svg?dataurl"
  import Icon from "@lib/components/Icon.svelte"
  import Link from "@lib/components/Link.svelte"
  import Button from "@lib/components/Button.svelte"
  import Page from "@lib/components/Page.svelte"
  import PageBar from "@lib/components/PageBar.svelte"
  import PageContent from "@lib/components/PageContent.svelte"
  import Spinner from "@lib/components/Spinner.svelte"
  import {goToChat, makeProfilePath} from "@app/ui/routes"
  import {beamhopConfig, beamhopConfigLoaded, loadBeamhopConfig} from "../config"
  import {
    directoryState,
    filterDirectory,
    groupByDepartment,
    loadDirectory,
  } from "../features/directory"

  let query = $state("")

  const groups = $derived(groupByDepartment(filterDirectory($directoryState.people, query)))

  onMount(async () => {
    await loadBeamhopConfig()
    await loadDirectory()
  })

  const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?"
</script>

<Page>
  <PageBar>
    <div class="flex min-w-0 items-center gap-2 whitespace-nowrap">
      <Icon icon={UsersGroup} size={6} />
      <strong>Directory</strong>
    </div>
  </PageBar>
  <PageContent class="flex flex-col gap-4 p-4" data-testid="beamhop-directory">
    {#if $beamhopConfigLoaded && !$beamhopConfig.features.directory}
      <p class="py-24 text-center text-content-muted">The company directory is not turned on.</p>
    {:else if $directoryState.loading && $directoryState.people.length === 0}
      <div class="flex justify-center p-12"><Spinner>Loading people…</Spinner></div>
    {:else if $directoryState.error === "signed-out"}
      <p class="py-24 text-center text-content-muted">
        Sign in with your company account to see the directory.
      </p>
    {:else if $directoryState.error}
      <p class="py-24 text-center text-content-muted">
        The directory is not available right now.
        <Button class="link" onclick={() => loadDirectory()}>Try again</Button>
      </p>
    {:else}
      <label class="input flex items-center gap-2">
        <Icon icon={Magnifier} class="shrink-0 text-content-muted" />
        <input
          class="grow"
          type="search"
          placeholder="Search people, teams or titles"
          bind:value={query} />
      </label>
      {#if groups.length === 0}
        <p class="py-12 text-center text-content-muted">No one matches “{query}”.</p>
      {/if}
      {#each groups as group (group.department)}
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-content-muted">{group.department || "Other"}</h3>
          <ul class="flex flex-col divide-y divide-line rounded-box border border-line">
            {#each group.people as person (person.pubkey)}
              <li class="flex items-center gap-3 p-3" data-testid="beamhop-directory-person">
                {#if person.picture}
                  <img
                    src={person.picture}
                    alt=""
                    class="h-10 w-10 shrink-0 rounded-full object-cover" />
                {:else}
                  <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-more font-semibold">
                    {initial(person.name)}
                  </span>
                {/if}
                <div class="min-w-0 flex-1">
                  <Link href={makeProfilePath(person.pubkey)} class="block truncate font-medium">
                    {person.name}
                  </Link>
                  <p class="truncate text-sm text-content-muted">
                    {[person.title, person.email].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Button class="button button-sm" onclick={() => goToChat([person.pubkey])}>
                  Message
                </Button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </PageContent>
</Page>
