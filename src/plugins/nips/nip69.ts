import type { RelayPlugin } from "../types";

export const nip69: RelayPlugin = { nip: "69", name: "Peer-to-peer Order events", relay: false, advertise: false, eventKinds: [38383] };
