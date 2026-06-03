/**
 * A client connection: a thin wrapper over a WebSocket-like sink that tracks
 * this connection's active subscriptions.
 */
import type { Filter, RelayMessage } from "./types.ts";

/** The minimal socket surface a Connection needs (satisfied by ServerWebSocket). */
export interface SocketLike {
  send(data: string): unknown;
}

export class Connection {
  readonly id: string;
  protected readonly socket: SocketLike;
  /** subscriptionId -> filters */
  readonly subscriptions = new Map<string, Filter[]>();

  /**
   * The pubkey this connection has authenticated as via NIP-42, or undefined if
   * it has not completed AUTH. Used to gate access to NIP-17 gift wraps.
   */
  authedPubkey?: string;

  /** The NIP-42 challenge issued to this connection (lazily created). */
  private challengeValue?: string;

  constructor(socket: SocketLike, id: string = crypto.randomUUID()) {
    this.socket = socket;
    this.id = id;
  }

  /**
   * The NIP-42 AUTH challenge for this connection, created on first access and
   * stable thereafter so a client's signed AUTH response can be matched to it.
   */
  get challenge(): string {
    return (this.challengeValue ??= crypto.randomUUID());
  }

  /** Serialize and send a relay message. */
  send(msg: RelayMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  addSub(subId: string, filters: Filter[]): void {
    this.subscriptions.set(subId, filters);
  }

  removeSub(subId: string): boolean {
    return this.subscriptions.delete(subId);
  }

  get subCount(): number {
    return this.subscriptions.size;
  }
}
