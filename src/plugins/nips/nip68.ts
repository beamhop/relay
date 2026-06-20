import type { RelayPlugin } from "../types";

export const nip68: RelayPlugin = { nip: "68", name: "Picture-first feeds", relay: false, advertise: false, eventKinds: [20] };
