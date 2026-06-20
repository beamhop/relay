import type { RelayPlugin } from "../types";

export const nip37: RelayPlugin = { nip: "37", name: "Draft Wraps", relay: false, advertise: false, eventKinds: [31234] };
