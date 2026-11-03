import { Buffer } from "node:buffer";
import type { ConnectionInfo, ConnectionSummary, EventBus, NostrEvent, RelaySocket } from "@beamhop/sdk";
import type { Negentropy } from "../nips/nip77/negentropy";
import { ipAddrKey, ipKey } from "../util/cidr";
import { Gate, MAX_QUERIES_PER_CONN } from "./read-limits";

/** Above this many queued bytes live events are dropped for the connection. */
export const SOFT_BUFFER_LIMIT = 1 << 20; // 1 MiB
/** Above this the connection is considered a stuck slow consumer and closed. */
const HARD_BUFFER_LIMIT = 8 << 20; // 8 MiB
/**
 * A connection whose send buffer stayed above SOFT_BUFFER_LIMIT this long (every live event dropped meanwhile) is
 * closed as a slow consumer. The buffer of a client that stopped reading never reaches HARD_BUFFER_LIMIT: live
 * delivery stops adding to it at SOFT_BUFFER_LIMIT (and Bun caps it at its 4 MiB backpressure limit anyway), so such
 * clients stayed connected, missing every event, until they went away (seen in soak runs: open after 5 minutes).
 */
export const SLOW_CONSUMER_MS = 30_000;

/** An event's JSON and its UTF-8 size (serialized once per broadcast, shared by all recipients). */
export interface EventJson {
  json: string;
  bytes: number;
}

export function serializeEvent(event: NostrEvent): EventJson {
  const json = JSON.stringify(event);
  return { json, bytes: Buffer.byteLength(json) };
}

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
  /** the same EVENTs by id, so a shutdown can answer them before the socket closes (see answerPending) */
  readonly awaitingOk = new Set<{ id: string; answered: boolean }>();
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
  /** since when live events have been dropped because the send buffer is over SOFT_BUFFER_LIMIT (0: not) */
  private congestedSince = 0;

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
    this.write(String(msg[0]), json, Buffer.byteLength(json));
  }

  /**
   * Sends ["EVENT", subId, event] given the event's JSON `body` and its UTF-8 size: fan-out serializes an
   * event once for all its recipients and only splices in each subscription id.
   */
  sendEventRaw(subId: string, body: string, bodyBytes: number): void {
    if (this.closed) return;
    const sid = JSON.stringify(subId);
    // `["EVENT",` + sid + `,` + body + `]`
    this.write("EVENT", `["EVENT",${sid},${body}]`, bodyBytes + Buffer.byteLength(sid) + 11);
  }

  private write(type: string, json: string, bytes: number): void {
    try {
      this.socket.send(json);
    } catch {
      this.closed = true;
      return;
    }
    this.messagesOut++;
    this.bus.emit("message.out", { connId: this.id, type, bytes });
  }

  /**
   * Live delivery with backpressure handling. Returns true if sent. `serialized` supplies the event's
   * JSON when it is shared with other recipients.
   */
  sendLive(subId: string, event: NostrEvent, serialized?: () => EventJson): boolean {
    const buffered = this.socket.bufferedAmount?.() ?? 0;
    if (buffered > HARD_BUFFER_LIMIT) {
      this.close(1008, "slow consumer");
      return false;
    }
    if (buffered > SOFT_BUFFER_LIMIT) {
      const now = Date.now();
      if (!this.congestedSince) this.congestedSince = now;
      else if (now - this.congestedSince >= SLOW_CONSUMER_MS) this.close(1008, "slow consumer");
      return false;
    }
    this.congestedSince = 0;
    const e = serialized ? serialized() : serializeEvent(event);
    this.sendEventRaw(subId, e.json, e.bytes);
    return true;
  }

  notice(message: string) {
    this.send(["NOTICE", message]);
  }

  ok(id: string, accepted: boolean, message: string) {
    this.send(["OK", id, accepted, message]);
  }

  /** OK false for every EVENT still awaiting its OK (their processing may still finish, but can't answer any more). */
  answerPending(message: string) {
    for (const p of this.awaitingOk) {
      if (p.answered) continue;
      p.answered = true;
      this.ok(p.id, false, message);
    }
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
