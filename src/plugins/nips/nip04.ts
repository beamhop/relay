import type { RelayPlugin } from "../types";

export const nip04: RelayPlugin = { nip: "04", name: "Encrypted Direct Message", relay: true, advertise: true, eventKinds: [4] };
