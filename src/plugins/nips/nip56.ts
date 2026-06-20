import type { RelayPlugin } from "../types";

export const nip56: RelayPlugin = { nip: "56", name: "Reporting", relay: false, advertise: false, eventKinds: [1984] };
