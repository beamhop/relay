import type { RelayPlugin } from "../types";

export const nip54: RelayPlugin = { nip: "54", name: "Wiki", relay: false, advertise: false, eventKinds: [30818] };
