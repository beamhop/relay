import type { RelayPlugin } from "../types";

export const nip73: RelayPlugin = { nip: "73", name: "External Content IDs", relay: false, advertise: false, eventKinds: [] };
