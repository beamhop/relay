import type { RelayPlugin } from "../types";

export const nip05: RelayPlugin = { nip: "05", name: "Mapping Nostr keys to DNS identifiers", relay: false, advertise: false, eventKinds: [] };
