import type { RelayPlugin } from "../types";

export const nip35: RelayPlugin = { nip: "35", name: "Torrents", relay: false, advertise: false, eventKinds: [2003] };
