/**
 * Test helpers: a fake socket/connection that captures sent relay messages.
 */
import { Connection, type SocketLike } from "../src/connection.ts";
import type { RelayMessage } from "../src/types.ts";

export class FakeSocket implements SocketLike {
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

/** A Connection over a FakeSocket, exposing the decoded messages it received. */
export class FakeConnection extends Connection {
  readonly fake: FakeSocket;
  constructor(id?: string) {
    const socket = new FakeSocket();
    super(socket, id);
    this.fake = socket;
  }
  /** All messages sent to this connection, decoded. */
  get messages(): RelayMessage[] {
    return this.fake.sent.map((s) => JSON.parse(s) as RelayMessage);
  }
  /** Messages of a given verb. */
  ofType<T extends RelayMessage[0]>(verb: T): Extract<RelayMessage, [T, ...unknown[]]>[] {
    return this.messages.filter((m) => m[0] === verb) as Extract<
      RelayMessage,
      [T, ...unknown[]]
    >[];
  }
}
