import type { RelayPlugin } from "../types";

export const nip21: RelayPlugin = { nip: "21", name: "nostr URI scheme", relay: false, advertise: false, eventKinds: [] };
