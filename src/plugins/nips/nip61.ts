import type { RelayPlugin } from "../types";

export const nip61: RelayPlugin = { nip: "61", name: "Nutzaps", relay: false, advertise: false, eventKinds: [9321, 9322, 10019] };
