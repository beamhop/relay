import type { RelayPlugin } from "../types";

export const nip27: RelayPlugin = { nip: "27", name: "Text Note References", relay: false, advertise: false, eventKinds: [1] };
