import { Buffer } from "node:buffer";
import type { ConnectionInfo, ConnectionSummary, EventBus, NostrEvent, RelaySocket } from "@beamhop/sdk";
import type { Negentropy } from "../nips/nip77/negentropy";
import { ipAddrKey, ipKey } from "../util/cidr";
import { Gate, MAX_QUERIES_PER_CONN } from "./read-limits";

/** Above this many queued bytes live events are dropped for the connection. */
export const SOFT_BUFFER_LIMIT = 1 << 20; // 1 MiB
/** Above this the connection is considered a stuck slow consumer and closed. */
const HARD_BUFFER_LIMIT = 8 << 20; // 8 MiB

export interface Subscription {
  conn: Connection;
  id: string;
  filters: import("@beamhop/sdk").Filter[];
  /** live events received while the stored query is still running (flushed after EOSE) */
  pending: NostrEvent[] | null;
  /** ids sent as stored results; used to dedupe pending live events */
  sentIds: Set<string> | null;
  abort: AbortController;
  /** filterWeight() of `filters`, counted against the connection's budget */
  weight: number;
}

export interface NegSession {
  neg: Negentropy;
  openedAt: number;
  /** last NEG-OPEN / NEG-MSG (idle sessions are closed) */
  lastActiveAt: number;
  /** items held (counted against the relay-wide negentropy budget) */
  items: number;
}

export class Connection implements ConnectionInfo {
  readonly authedPubkeys = new Set<string>();
  readonly connectedAt = Date.now();
  readonly subs = new Map<string, Subscription>();
  readonly negSessions = new Map<string, NegSession>();
  /** rate-limit key for the client network (IPv6 aggregated to /64) */
  readonly ipKey: string;
  /** key of the exact client address (connection cap per address) */
  readonly addrKey: string;
  messagesIn = 0;
  messagesOut = 0;
  closed = false;
  /** serializes EVENT processing per connection so OKs are returned in order */
  queue: Promise<unknown> = Promise.resolve();
  /** EVENTs received but not yet answered with OK */
  inflightEvents = 0;
  /** sum of the weights of open subscriptions */
  filterWeight = 0;
  /** NEG-OPENs being prepared (not yet in negSessions) */
  negOpening = 0;
  /** authenticated as relay staff, or connecting from an allow-listed IP: exempt from the inbound message limit */
  trusted = false;
  /** inbound messages per minute; raised for users with a rate-limit override (their own limits apply instead) */
  messagesPerMinute: number;
  /** skip the per-address message bucket (staff, allow-listed IPs, users with rate-limit overrides) */
  ownMessageLimit = false;
  /** EVENTs that may await their OK at once */
  maxInflightEvents: number;
  /** messages refused by the inbound message limit since `refusedSince` (a one-minute window) */
  refused = 0;
  refusedSince = 0;
  /** stored queries running (incl. streaming their results); further REQs wait for a slot */
  readonly queries = new Gate(MAX_QUERIES_PER_CONN);
  /** estimated bytes of stored results materialized but not yet sent */
  resultBytes = 0;

  constructor(
    readonly id: string,
    readonly socket: RelaySocket,
    readonly ip: string,
    readonly challenge: string,
    private readonly bus: EventBus,
    limits: { messagesPerMinute: number; maxInflightEvents: number },
    readonly userAgent?: string,
    /** part of the plugin-facing ConnectionInfo (write/read hook contexts) */
    readonly origin?: string,
  ) {
    this.ipKey = ipKey(ip);
    this.addrKey = ipAddrKey(ip);
    this.messagesPerMinute = limits.messagesPerMinute;
    this.maxInflightEvents = limits.maxInflightEvents;
  }

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
    if (buffered > SOFT_BUFFER_LIMIT) return false;
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
