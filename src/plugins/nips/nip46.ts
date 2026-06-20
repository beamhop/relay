import type { RelayPlugin } from "../types";

export const nip46: RelayPlugin = { nip: "46", name: "Nostr Remote Signing", relay: false, advertise: false, eventKinds: [24133, 24134] };
