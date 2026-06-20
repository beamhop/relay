import type { RelayPlugin } from "../types";

export const nip40: RelayPlugin = {
  nip: "40",
  name: "Expiration Timestamp",
  relay: true,
  advertise: true,
  eventKinds: [],
  validateEvent: (event) => {
    const expiration = event.tags.find((tag) => tag[0] === "expiration")?.[1];
    if (expiration && Number(expiration) <= Math.floor(Date.now() / 1000)) {
      return { ok: false, prefix: "invalid", message: "event is expired" };
    }
    return { ok: true };
  },
};
