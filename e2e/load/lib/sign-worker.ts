/// <reference lib="webworker" />
import { finalizeEvent } from "nostr-tools";
import type { SignJob } from "./sign";

declare const self: Worker;

self.onmessage = (m: MessageEvent<SignJob[]>) => {
  self.postMessage(m.data.map((j) => finalizeEvent(j.t, j.sk)));
};
