import type { RelayPlugin } from "../types";

export const nip11: RelayPlugin = { nip: "11", name: "Relay Information Document", relay: true, advertise: true, eventKinds: [] };
