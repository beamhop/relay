import type { RelayPlugin } from "../types";

export const nip32: RelayPlugin = { nip: "32", name: "Labeling", relay: false, advertise: false, eventKinds: [1985] };
