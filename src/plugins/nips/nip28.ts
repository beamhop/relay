import type { RelayPlugin } from "../types";

export const nip28: RelayPlugin = { nip: "28", name: "Public Chat", relay: false, advertise: false, eventKinds: [40, 41, 42, 43, 44] };
