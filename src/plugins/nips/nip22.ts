import type { RelayPlugin } from "../types";

export const nip22: RelayPlugin = { nip: "22", name: "Comment", relay: false, advertise: false, eventKinds: [1111] };
