import type { RelayPlugin } from "../types";

export const nip25: RelayPlugin = { nip: "25", name: "Reactions", relay: false, advertise: false, eventKinds: [7, 17] };
