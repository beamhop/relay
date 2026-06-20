import type { RelayPlugin } from "../types";

export const nip94: RelayPlugin = { nip: "94", name: "File Metadata", relay: false, advertise: false, eventKinds: [1063] };
