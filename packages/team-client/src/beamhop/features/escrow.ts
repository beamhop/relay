// SPDX-License-Identifier: AGPL-3.0-or-later
// Extension point: DM escrow disclosure (PLAN §12.8). When the workspace has escrow enabled,
// Beamhop sets `features.escrowNotice: true` in config.json and the client shows a banner.
// Rendered by src/beamhop/components/EscrowNotice.svelte.

import {derived, writable} from "svelte/store"
import {beamhopConfig} from "../config"

export const ESCROW_NOTICE_TEXT =
  "Your messages on this workspace may be accessed by your company for compliance."

const dismissed = writable(false)

export const dismissEscrowNotice = () => dismissed.set(true)

export const showEscrowNotice = derived(
  [beamhopConfig, dismissed],
  ([$config, $dismissed]) => $config.features.escrowNotice && !$dismissed,
)
