import type { RelayPlugin } from "../types";

export const nip57: RelayPlugin = { nip: "57", name: "Lightning Zaps", relay: false, advertise: false, eventKinds: [9734, 9735] };
