import type { RelayPlugin } from "../types";

export const nip90: RelayPlugin = { nip: "90", name: "Data Vending Machines", relay: false, advertise: false, eventKinds: [5000, 5999, 6000, 6999, 7000] };
