// SPDX-License-Identifier: AGPL-3.0-or-later
// Welshman wiring for the company sign-in (./sso.ts): NIP-46 login through Beamhop's bunker
// (managed keys) and the person's own signer (NIP-07 extension, or the signer of the session
// they are already logged in with, e.g. a NIP-46 remote signer) for self-custody.

import {get} from "svelte/store"
import {Nip07Signer, Nip46Broker, getNip07} from "@welshman/signer"
import {getSignerFromSession, nip07, nip46, toSession} from "@welshman/app"
import {makeSecret} from "@welshman/util"
import {login, session} from "@app/core/session"
import {NIP46_PERMS} from "@app/core/nip46"
import {setChecked} from "@app/ui/notifications"
import {trustRelays} from "../federation"
import {
  signInWithTeamSession,
  TeamSessionError,
  type EventTemplate,
  type SignedEvent,
  type TeamSignInResult,
  type UserSigner,
} from "./sso"

/** Managed key: connect to Beamhop's bunker and log in; the bunker must hold `pubkey`. */
export const loginWithTeamBunker = async (bunkerUrl: string, pubkey: string) => {
  const {signerPubkey, connectSecret, relays} = Nip46Broker.parseBunkerUrl(bunkerUrl)

  if (!signerPubkey || relays.length === 0) {
    throw new TeamSessionError("Beamhop returned an invalid bunker link", "invalid")
  }

  // The bunker relays come from Beamhop itself (same-origin session answer): allow them.
  trustRelays(relays)

  const clientSecret = makeSecret()
  const broker = new Nip46Broker({relays, clientSecret, signerPubkey})

  try {
    const result = await broker.connect(connectSecret, NIP46_PERMS)
    const actual = await broker.getPublicKey()

    if (!["ack", connectSecret].includes(result)) {
      throw new TeamSessionError("The company signer did not accept the connection", "http")
    }

    if (actual !== pubkey) {
      throw new TeamSessionError(
        "The company signer holds a different key than expected",
        "wrong-key",
      )
    }

    trustRelays(broker.params.relays)
    await login(toSession(nip46, {clientSecret, signerPubkey, relays: broker.params.relays}))
    setChecked("*")
  } finally {
    broker.cleanup()
  }
}

/** The signer of the current session, else the NIP-07 extension, else none. */
export const currentUserSigner = async (): Promise<UserSigner | undefined> => {
  const $session = get(session)

  if ($session) {
    const signer = await getSignerFromSession($session)

    if (signer) {
      return {
        getPubkey: () => signer.getPubkey(),
        sign: (t: EventTemplate) => signer.sign(t) as Promise<SignedEvent>,
        login: async () => {},
      }
    }
  }

  if (getNip07()) {
    const signer = new Nip07Signer()

    return {
      getPubkey: () => signer.getPubkey(),
      sign: (t: EventTemplate) => signer.sign(t) as Promise<SignedEvent>,
      login: async () => {
        await login(toSession(nip07, {}))
        setChecked("*")
      },
    }
  }

  return undefined
}

export const runTeamSignIn = (): Promise<TeamSignInResult> =>
  signInWithTeamSession({loginWithBunker: loginWithTeamBunker, userSigner: currentUserSigner})
