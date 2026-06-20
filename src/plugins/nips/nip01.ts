import type { RelayPlugin } from "../types";

export const nip01: RelayPlugin = { nip: "01", name: "Basic protocol flow description", relay: true, advertise: true, eventKinds: [0] };
