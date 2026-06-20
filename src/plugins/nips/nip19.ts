import type { RelayPlugin } from "../types";

export const nip19: RelayPlugin = { nip: "19", name: "bech32-encoded entities", relay: false, advertise: false, eventKinds: [] };
