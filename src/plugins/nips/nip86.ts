import type { RelayPlugin } from "../types";

export const nip86: RelayPlugin = { nip: "86", name: "Relay Management API", relay: true, advertise: true, eventKinds: [] };
