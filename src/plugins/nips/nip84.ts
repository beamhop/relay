import type { RelayPlugin } from "../types";

export const nip84: RelayPlugin = { nip: "84", name: "Highlights", relay: false, advertise: false, eventKinds: [9802] };
