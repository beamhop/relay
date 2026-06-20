import type { RelayPlugin } from "../types";

export const nip78: RelayPlugin = { nip: "78", name: "Application-specific data", relay: false, advertise: false, eventKinds: [30078] };
