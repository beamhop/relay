import type { RelayPlugin } from "../types";

export const nip48: RelayPlugin = { nip: "48", name: "Bridged Events", relay: false, advertise: false, eventKinds: [] };
