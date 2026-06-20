import { giftWrapAccessHooks } from "./giftWrap";
import type { RelayPlugin } from "../types";

export const nip17: RelayPlugin = {
  nip: "17",
  name: "Private Direct Messages",
  relay: true,
  advertise: true,
  eventKinds: [14, 15, 10050],
  ...giftWrapAccessHooks(),
};
