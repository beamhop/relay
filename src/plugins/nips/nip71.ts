import type { RelayPlugin } from "../types";

export const nip71: RelayPlugin = { nip: "71", name: "Video Events", relay: false, advertise: false, eventKinds: [21, 22, 34235] };
