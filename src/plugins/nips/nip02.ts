import type { RelayPlugin } from "../types";

export const nip02: RelayPlugin = { nip: "02", name: "Follow List", relay: false, advertise: false, eventKinds: [3] };
