import type { RelayPlugin } from "../types";

export const nip85: RelayPlugin = { nip: "85", name: "Trusted Assertions", relay: false, advertise: false, eventKinds: [] };
