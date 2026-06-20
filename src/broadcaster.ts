import type { NostrEvent } from "./types";

export type BroadcastHandler = (event: NostrEvent) => void | Promise<void>;

/**
 * The cross-instance announcement seam (ADR-0003). An accepted event is `announce`d; every
 * instance that has `subscribe`d fans it out to its own local subscribers.
 *
 * Phase 1 is single-pod, so the default implementation is in-process. HA later swaps this for a
 * Postgres `NOTIFY` (or Redis pub/sub) broadcaster without touching the fan-out logic.
 */
export interface Broadcaster {
  /** Announce an accepted event for fan-out. Resolves once local delivery has been dispatched. */
  announce(event: NostrEvent): Promise<void>;
  /** Register a handler that fans an announced event out to this instance's subscribers. */
  subscribe(handler: BroadcastHandler): void;
  /** Release any bus resources. No-op in-process. */
  close(): Promise<void>;
}

/** Default Phase 1 broadcaster: deliver announcements to local handlers in-process. */
export class InProcessBroadcaster implements Broadcaster {
  private readonly handlers: BroadcastHandler[] = [];

  async announce(event: NostrEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }

  subscribe(handler: BroadcastHandler): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {}
}
