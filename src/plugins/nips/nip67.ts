import type { RelayPlugin } from "../types";

export const nip67: RelayPlugin = { nip: "67", name: "EOSE Completeness Hint", relay: true, advertise: true, eventKinds: [] };
