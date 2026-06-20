import type { RelayPlugin } from "../types";

export const nip53: RelayPlugin = { nip: "53", name: "Live Streaming and Spaces", relay: false, advertise: false, eventKinds: [30311, 1311] };
