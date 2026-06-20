import type { RelayPlugin } from "../types";

export const nip44: RelayPlugin = { nip: "44", name: "Encrypted Payloads", relay: false, advertise: false, eventKinds: [] };
