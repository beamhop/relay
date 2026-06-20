import type { RelayPlugin } from "../types";

export const nip16: RelayPlugin = { nip: "16", name: "Event Treatment", relay: true, advertise: true, eventKinds: [] };
