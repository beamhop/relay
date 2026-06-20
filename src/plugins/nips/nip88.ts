import type { RelayPlugin } from "../types";

export const nip88: RelayPlugin = { nip: "88", name: "Polls", relay: false, advertise: false, eventKinds: [1068, 1018] };
