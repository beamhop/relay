import type { RelayPlugin } from "../types";

export const nip89: RelayPlugin = { nip: "89", name: "Recommended Application Handlers", relay: false, advertise: false, eventKinds: [31989, 31990] };
