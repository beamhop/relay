/**
 * Signature verification worker (see VerifyPool): answers `{ id, items: [id, pubkey, sig][] }` with
 * `{ id, ok: boolean[] }`. Built as its own file next to the bundle (scripts/build-node.ts, build-binary.ts).
 */
import { parentPort } from "node:worker_threads";
import { schnorrOk } from "./schnorr";

parentPort?.on("message", (msg: { id: number; items: [string, string, string][] }) => {
  parentPort!.postMessage({ id: msg.id, ok: msg.items.map(([id, pubkey, sig]) => schnorrOk(id, pubkey, sig)) });
});
