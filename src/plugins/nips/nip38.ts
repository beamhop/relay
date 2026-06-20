import type { RelayPlugin } from "../types";

export const nip38: RelayPlugin = { nip: "38", name: "User Statuses", relay: false, advertise: false, eventKinds: [30315] };
