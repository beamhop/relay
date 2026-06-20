import type { RelayPlugin } from "../types";

export const nip31: RelayPlugin = { nip: "31", name: "Dealing with Unknown Events", relay: false, advertise: false, eventKinds: [] };
