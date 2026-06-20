import type { RelayPlugin } from "../types";

export const nip65: RelayPlugin = { nip: "65", name: "Relay List Metadata", relay: false, advertise: false, eventKinds: [10002] };
