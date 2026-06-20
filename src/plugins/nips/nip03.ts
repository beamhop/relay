import type { RelayPlugin } from "../types";

export const nip03: RelayPlugin = { nip: "03", name: "OpenTimestamps Attestations for Events", relay: false, advertise: false, eventKinds: [] };
