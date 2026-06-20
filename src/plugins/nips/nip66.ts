import type { RelayPlugin } from "../types";

export const nip66: RelayPlugin = { nip: "66", name: "Relay Liveness Monitoring", relay: true, advertise: true, eventKinds: [10166, 30166] };
