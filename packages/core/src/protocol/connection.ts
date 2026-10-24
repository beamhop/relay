import { Buffer } from "node:buffer";
import type { ConnectionInfo, ConnectionSummary, EventBus, NostrEvent, RelaySocket } from "@beamhop/sdk";
import type { Negentropy } from "../nips/nip77/negentropy";

/** Above this many queued bytes live events are dropped for the connection. */
export const SOFT_BUFFER_LIMIT = 1 << 20; // 1 MiB
/** Above this the connection is considered a stuck slow consumer and closed. */
export const HARD_BUFFER_LIMIT = 8 << 20; // 8 MiB

export interface Subscription {
  conn: Connection;
  id: string;
  filters: import("@beamhop/sdk").Filter[];
  /** live events received while the stored query is still running (flushed after EOSE) */
  pending: NostrEvent[] | null;
  /** ids sent as stored results; used to dedupe pending live events */
  sentIds: Set<string> | null;
  abort: AbortController;
}

export interface NegSession {
  neg: Negentropy;
  lastActiveAt: number;
}

export class Connection implements ConnectionInfo {
  readonly authedPubkeys = new Set<string>();
  readonly connectedAt = Date.now();
  readonly subs = new Map<string, Subscription>();
  readonly negSessions = new Map<string, NegSession>();
  messagesIn = 0;
  messagesOut = 0;
  droppedEvents = 0;
  closed = false;
  /** serializes EVENT processing per connection so OKs are returned in order */
  queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly socket: RelaySocket,
    readonly ip: string,
    readonly challenge: string,
    private readonly bus: EventBus,
    readonly userAgent?: string,
    readonly origin?: string,
  ) {}

  send(msg: unknown[]): void {
    if (this.closed) return;
    const json = JSON.stringify(msg);
    try {
      this.socket.send(json);
    } catch {
      this.closed = true;
      return;
    }
    this.messagesOut++;
    this.bus.emit("message.out", { connId: this.id, type: String(msg[0]), bytes: Buffer.byteLength(json) });
  }

  /** Live delivery with backpressure handling. Returns true if sent. */
  sendLive(subId: string, event: NostrEvent): boolean {
    const buffered = this.socket.bufferedAmount?.() ?? 0;
    if (buffered > HARD_BUFFER_LIMIT) {
      this.close(1008, "slow consumer");
      return false;
    }
    if (buffered > SOFT_BUFFER_LIMIT) {
      this.droppedEvents++;
      return false;
    }
    this.send(["EVENT", subId, event]);
    return true;
  }

  notice(message: string) {
    this.send(["NOTICE", message]);
  }

  ok(id: string, accepted: boolean, message: string) {
    this.send(["OK", id, accepted, message]);
  }

  closedSub(subId: string, message: string) {
    this.send(["CLOSED", subId, message]);
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  summary(): ConnectionSummary {
    return {
      id: this.id,
      ip: this.ip,
      userAgent: this.userAgent,
      authedPubkeys: [...this.authedPubkeys],
      subscriptions: this.subs.size,
      connectedAt: this.connectedAt,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
    };
  }
}
