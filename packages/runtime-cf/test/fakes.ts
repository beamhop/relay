// SPDX-License-Identifier: AGPL-3.0-or-later
/** In-process fakes of the Cloudflare APIs used by runtime-cf (structural types). */
import {
  type BeamhopModule,
  type Connection,
  type Filter,
  type Kernel,
  defineModule,
  matchFilters,
} from '@beamhop/core';
import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DurableObjectStubLike,
  HibernatableWebSocket,
} from '../src/cf-types.ts';
import type { CfEnv } from '../src/env.ts';
import { type CloudflareRuntimeOptions, createCloudflareRuntime } from '../src/runtime.ts';

export class FakeWebSocket implements HibernatableWebSocket {
  sent: string[] = [];
  readyState = 1;
  closedWith: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;

  send(message: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('socket closed');
    this.sent.push(String(message));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (size > 2048) throw new Error(`attachment too large: ${size}`);
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export class FakeStorage implements DurableObjectStorageLike {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(t: number): Promise<void> {
    this.alarm = t;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

export class FakeState implements DurableObjectStateLike {
  readonly storage = new FakeStorage();
  sockets: FakeWebSocket[] = [];
  constructor(readonly id: DurableObjectIdLike) {}
  acceptWebSocket(ws: HibernatableWebSocket): void {
    this.sockets.push(ws as FakeWebSocket);
  }
  getWebSockets(): HibernatableWebSocket[] {
    return this.sockets.filter((s) => s.readyState === 1);
  }
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export interface RoomInstance {
  fetch(req: Request): Promise<Response>;
  webSocketMessage(ws: HibernatableWebSocket, m: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: HibernatableWebSocket, code: number, reason: string): Promise<void>;
  alarm(): Promise<void>;
  core: import('../src/room.ts').RelayRoomCore;
}

type RoomCtor = new (state: DurableObjectStateLike, env: CfEnv) => RoomInstance;

/** Namespace that instantiates rooms in-process; `hibernate(name)` drops the instance. */
export class FakeNamespace implements DurableObjectNamespaceLike {
  Room: RoomCtor | null = null;
  env: CfEnv | null = null;
  states = new Map<string, FakeState>();
  instances = new Map<string, RoomInstance>();
  requests: Array<{ name: string; url: string; headers: Headers }> = [];

  idFromName(name: string): DurableObjectIdLike {
    return { name, toString: () => `id:${name}` };
  }
  instance(name: string): RoomInstance {
    let inst = this.instances.get(name);
    if (!inst) {
      let state = this.states.get(name);
      if (!state) {
        state = new FakeState(this.idFromName(name));
        this.states.set(name, state);
      }
      inst = new (this.Room as RoomCtor)(state, this.env as CfEnv);
      this.instances.set(name, inst);
    }
    return inst;
  }
  get(id: DurableObjectIdLike): DurableObjectStubLike {
    const name = id.name as string;
    return {
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        this.requests.push({ name, url: req.url, headers: req.headers });
        return this.instance(name).fetch(req);
      },
    };
  }
  /** Simulate hibernation: the in-memory object is gone, state + sockets survive. */
  hibernate(name: string): void {
    this.instances.delete(name);
  }
}

// ───────────── a tiny relay-like ConnectionHandler for tests ─────────────

const NS = 'test-relay';

interface TestRelayState {
  subs: Map<string, Filter[]>;
}

export interface TestRelayProbe {
  restored: string[];
  kernels: Kernel[];
}

/**
 * Minimal relay: REQ stores subs in `conn.state` (after an async hop, like a real
 * store query), EVENT publishes on `events:<relayId>`, AUTH marks the pubkey authed.
 * Live delivery uses an in-memory index rebuilt in `onRestore`.
 */
export function testRelayModule(probe: TestRelayProbe): BeamhopModule {
  return defineModule({
    id: 'test-relay',
    register(kernel) {
      probe.kernels.push(kernel);
      const live = new Map<string, Connection>();
      const st = (c: Connection) => {
        let s = c.state.get(NS) as TestRelayState | undefined;
        if (!s) {
          s = { subs: new Map() };
          c.state.set(NS, s);
        }
        return s;
      };
      const unsub = new Map<string, () => void>();
      const ensureChannel = (relayId: string) => {
        if (unsub.has(relayId)) return;
        unsub.set(
          relayId,
          kernel.ports.pubsub.subscribe(`events:${relayId}`, (m) => {
            const ev = m as Parameters<typeof matchFilters>[1];
            for (const c of live.values()) {
              for (const [id, filters] of st(c).subs) {
                if (matchFilters(filters, ev)) c.send(JSON.stringify(['EVENT', id, ev]));
              }
            }
          }),
        );
      };
      kernel.ws = {
        onOpen(conn) {
          live.set(conn.id, conn);
          ensureChannel(conn.relayId);
          conn.send(JSON.stringify(['AUTH', conn.challenge]));
        },
        onRestore(conn) {
          probe.restored.push(conn.id);
          live.set(conn.id, conn);
          ensureChannel(conn.relayId);
        },
        onClose(conn) {
          live.delete(conn.id);
        },
        onMessage(conn, raw) {
          const msg = JSON.parse(raw) as [string, ...unknown[]];
          if (msg[0] === 'REQ') {
            const [, id, ...filters] = msg as [string, string, ...Filter[]];
            void Promise.resolve().then(() => {
              st(conn).subs.set(id, filters);
              conn.send(JSON.stringify(['EOSE', id]));
            });
          } else if (msg[0] === 'AUTH') {
            conn.authed.add(String(msg[1]));
            conn.send(JSON.stringify(['OK', 'auth', true, '']));
          } else if (msg[0] === 'EVENT') {
            const ev = msg[1] as { id: string };
            void kernel.ports.pubsub.publish(`events:${conn.relayId}`, ev);
            conn.send(JSON.stringify(['OK', ev.id, true, '']));
          } else if (msg[0] === 'BIG') {
            conn.state.set('blob', 'x'.repeat(Number(msg[1])));
            conn.send(JSON.stringify(['OK', 'big', true, '']));
          }
        },
      };
    },
  });
}

export const TEST_CONFIG = {
  relays: [
    { id: 'alpha', hosts: ['alpha.example'] },
    { id: 'beta', hosts: ['beta.example'], pathPrefix: '/beta' },
  ],
};

export function setup(opts: CloudflareRuntimeOptions & { env?: Partial<CfEnv> } = {}): {
  runtime: ReturnType<typeof createCloudflareRuntime>;
  ns: FakeNamespace;
  env: CfEnv;
  probe: TestRelayProbe;
  logs: string[];
} {
  const probe: TestRelayProbe = { restored: [], kernels: [] };
  const logs: string[] = [];
  const ns = new FakeNamespace();
  const runtime = createCloudflareRuntime({
    config: TEST_CONFIG,
    modules: [testRelayModule(probe)],
    logSink: (line) => logs.push(line),
    room: {
      createPair: () => ({ client: {}, server: new FakeWebSocket() }),
      upgradeResponse: () => new Response(null, { status: 200, headers: { 'x-upgraded': '1' } }),
      defer: () => {},
    },
    ...opts,
  });
  const env = { RELAY_ROOM: ns, IP_HASH_SALT: 'test-salt', ...opts.env } as CfEnv;
  ns.Room = runtime.RelayRoom as unknown as RoomCtor;
  ns.env = env;
  return { runtime, ns, env, probe, logs };
}

export function upgradeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { upgrade: 'websocket', ...headers } });
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
