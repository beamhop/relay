import { giftWrapAccessHooks } from "./giftWrap";
import type { RelayPlugin } from "../types";

export const nip59: RelayPlugin = {
  nip: "59",
  name: "Gift Wrap",
  relay: true,
  advertise: true,
  eventKinds: [13, 1059, 21059],
  ...giftWrapAccessHooks(),
};
