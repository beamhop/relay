<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  Company sign-in follow-up (PLAN §13). After the IdP redirect, ask Beamhop how this person signs:
  managed keys log in automatically through the bunker; self-custody asks for the person's own
  signer (and checks it is the linked key); a missing link is created by signing a challenge.
-->
<script lang="ts">
  import {onMount} from "svelte"
  import {get} from "svelte/store"
  import {getNip07} from "@welshman/signer"
  import {getSignerFromSession} from "@welshman/app"
  import Button from "@lib/components/Button.svelte"
  import Spinner from "@lib/components/Spinner.svelte"
  import LogIn from "@app/components/LogIn.svelte"
  import {session} from "@app/core/session"
  import {pushModal} from "@app/ui/modal"
  import {pushToast} from "@app/ui/toast"
  import {loadBeamhopConfig} from "../config"
  import {
    isSsoEnabled,
    requestTeamSession,
    TeamSessionError,
    type TeamSession,
  } from "../features/sso"
  import {runTeamSignIn} from "../features/sso-session"

  type State =
    | {kind: "idle"}
    | {kind: "busy"}
    | {kind: "needs-signer"}
    | {kind: "link"}
    | {kind: "wrong-key"}
    | {kind: "error"; message: string}

  let state: State = $state({kind: "idle"})

  const currentPubkey = async () => {
    const current = get(session)
    const signer = current ? await getSignerFromSession(current) : undefined

    return signer ? (await signer.getPubkey()).toLowerCase() : undefined
  }

  const evaluate = async (s: TeamSession) => {
    const pubkey = await currentPubkey()

    if (s.mode === "managed") {
      if (!pubkey) await run(true)
      return
    }

    if (s.mode === "self-custody") {
      if (!pubkey) state = {kind: "needs-signer"}
      else if (pubkey !== s.pubkey) state = {kind: "wrong-key"}
      return
    }

    state = pubkey ? {kind: "link"} : {kind: "needs-signer"}
  }

  const check = async () => {
    try {
      await evaluate(await requestTeamSession())
    } catch (e) {
      // No company session yet (signed out with the IdP) is the normal case: nothing to show.
      if (e instanceof TeamSessionError && (e.code === "signed-out" || e.code === "disabled"))
        return

      state = {kind: "error", message: e instanceof Error ? e.message : String(e)}
    }
  }

  const run = async (quiet = false) => {
    state = {kind: "busy"}

    try {
      const r = await runTeamSignIn()

      state = {kind: "idle"}
      pushToast({
        message: r.linked
          ? "Your Nostr key is now linked to your company account."
          : "Signed in with your company account.",
      })
    } catch (e) {
      if (e instanceof TeamSessionError && e.code === "no-signer") state = {kind: "needs-signer"}
      else if (e instanceof TeamSessionError && e.code === "wrong-key") state = {kind: "wrong-key"}
      else state = {kind: "error", message: e instanceof Error ? e.message : String(e)}

      if (!quiet && state.kind === "error") pushToast({theme: "error", message: state.message})
    }
  }

  const openLogin = () => pushModal(LogIn)

  onMount(async () => {
    await loadBeamhopConfig()

    if (isSsoEnabled()) await check()
  })

  // Logging in with a signer while a step is pending: re-check (link or verify the key).
  let lastSession = get(session)

  $effect(() => {
    const s = $session

    if (s !== lastSession) {
      lastSession = s

      if (s && (state.kind === "needs-signer" || state.kind === "wrong-key")) void check()
    }
  })

  const dismiss = () => (state = {kind: "idle"})
</script>

{#if state.kind !== "idle"}
  <div
    role="status"
    data-testid="beamhop-team-session"
    data-state={state.kind}
    class="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 border-b border-line bg-surface-more px-4 py-2 text-sm"
    style="padding-top: max(0.5rem, env(safe-area-inset-top));">
    {#if state.kind === "busy"}
      <Spinner size="sm" /> Connecting your company account…
    {:else if state.kind === "needs-signer"}
      <span>Your company account uses your own Nostr key. Log in with your signer to finish.</span>
      {#if getNip07()}
        <Button class="button button-primary button-sm" onclick={() => run()}
          >Use browser extension</Button>
      {/if}
      <Button class="button button-sm" onclick={openLogin}>Log in with a signer</Button>
    {:else if state.kind === "link"}
      <span>Link the key you are logged in with to your company account?</span>
      <Button class="button button-primary button-sm" onclick={() => run()}>Link my key</Button>
      <Button class="link" onclick={dismiss}>Not now</Button>
    {:else if state.kind === "wrong-key"}
      <span>
        You are logged in with a different key than the one linked to your company account. Switch
        to the linked key, or ask an admin to reset the link.
      </span>
      <Button class="link" onclick={dismiss}>Got it</Button>
    {:else if state.kind === "error"}
      <span>{state.message}</span>
      <Button class="link" onclick={() => check()}>Try again</Button>
      <Button class="link" onclick={dismiss}>Close</Button>
    {/if}
  </div>
{/if}
