import type { RelayPlugin } from "../types";

export const nip58: RelayPlugin = { nip: "58", name: "Badges", relay: false, advertise: false, eventKinds: [8, 30008, 30009] };
