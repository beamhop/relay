import type { RelayPlugin } from "../types";

export const nip42: RelayPlugin = { nip: "42", name: "Authentication of clients to relays", relay: true, advertise: true, eventKinds: [22242] };
