import type { RelayPlugin } from "../types";

export const nip14: RelayPlugin = { nip: "14", name: "Subject tag in text events", relay: false, advertise: false, eventKinds: [1] };
