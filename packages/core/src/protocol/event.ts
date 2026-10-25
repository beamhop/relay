import type { NostrEvent } from "@beamhop/sdk";
import { SHUTTING_DOWN } from "../constants";
import type { RelayContext } from "../context";
import { processEvent } from "../pipeline/write";
import type { Connection } from "./connection";

// ------------------------------------------------------------------ EVENT

export function handleEvent(ctx: RelayContext, conn: Connection, event: NostrEvent, bytes: number): void {
  // bounded: the per-connection queue would otherwise grow without limit when events arrive faster than they're stored
  if (conn.inflightEvents >= conn.maxInflightEvents) return conn.ok(event.id, false, "rate-limited: too many events awaiting OK; slow down");
  conn.inflightEvents++;
  const pending = { id: event.id, answered: false };
  conn.awaitingOk.add(pending);
  const answer = (ok: boolean, message: string) => {
    if (pending.answered) return;
    pending.answered = true;
    conn.ok(event.id, ok, message);
  };
  // serialize per connection so OK messages keep submission order
  conn.queue = conn.queue.then(async () => {
    try {
      if (conn.closed) return;
      // shutting down past its deadline: answered rather than processed (relay.stop answers whatever is left)
      if (ctx.refuseQueuedEvents) return answer(false, SHUTTING_DOWN);
      const res = await processEvent(ctx, event, { conn, source: "ws", bytes });
      answer(res.ok, res.message);
    } catch (err) {
      // a failing event must neither go unanswered nor break the chain for the ones queued behind it
      ctx.logger.error("EVENT handler failed", { err: String(err) });
      answer(false, "error: internal error");
    } finally {
      conn.inflightEvents--;
      conn.awaitingOk.delete(pending);
    }
  });
}
