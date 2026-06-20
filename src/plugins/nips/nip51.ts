import type { RelayPlugin } from "../types";

export const nip51: RelayPlugin = { nip: "51", name: "Lists", relay: false, advertise: false, eventKinds: [10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10009, 30000, 30001, 30002, 30003, 30004, 30005, 30007, 30015] };
