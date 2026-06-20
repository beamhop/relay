import type { RelayPlugin } from "../types";

export const nip98: RelayPlugin = { nip: "98", name: "HTTP Auth", relay: false, advertise: false, eventKinds: [27235] };
