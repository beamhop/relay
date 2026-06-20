import type { RelayPlugin } from "../types";

export const nip23: RelayPlugin = { nip: "23", name: "Long-form Content", relay: false, advertise: false, eventKinds: [30023] };
