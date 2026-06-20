import type { RelayPlugin } from "../types";

export const nip09: RelayPlugin = {
  nip: "09",
  name: "Event Deletion Request",
  relay: true,
  advertise: true,
  eventKinds: [5],
  afterEventAccepted: async (event, context) => {
    await context.store.applyDeletionRequest(event);
  },
};
