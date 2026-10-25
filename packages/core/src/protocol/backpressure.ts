import type { Connection } from "./connection";
import { BACKPRESSURE } from "./limits";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const yieldToLoop = () => new Promise((r) => setImmediate(r));

/**
 * Waits while the client's send buffer is above the soft limit (stored results honour backpressure
 * like live delivery). Returns false when the connection closed, the subscription was cancelled, or
 * the client didn't drain in time (it is then disconnected as a slow consumer).
 */
export async function waitForDrain(conn: Connection, signal?: AbortSignal): Promise<boolean> {
  const buffered = () => conn.socket.bufferedAmount?.() ?? 0;
  // RelaySocket has no drain event, so this polls
  if (buffered() <= BACKPRESSURE.highWater) return !conn.closed;
  const deadline = Date.now() + BACKPRESSURE.drainTimeoutMs;
  while (!conn.closed && !signal?.aborted) {
    await sleep(BACKPRESSURE.pollMs);
    if (buffered() <= BACKPRESSURE.highWater) return !conn.closed && !signal?.aborted;
    if (Date.now() >= deadline) {
      conn.close(1008, "slow consumer");
      return false;
    }
  }
  return false;
}
