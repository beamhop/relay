import type { RelayPlugin } from "../types";

export const nip18: RelayPlugin = { nip: "18", name: "Reposts", relay: false, advertise: false, eventKinds: [6, 16] };
