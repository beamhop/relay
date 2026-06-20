import type { RelayPlugin } from "../types";

export const nip47: RelayPlugin = { nip: "47", name: "Nostr Wallet Connect", relay: false, advertise: false, eventKinds: [23194, 23195, 23196, 23197] };
