// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AppEventName,
  type AppEvents,
  type BeamhopModule,
  type Connection,
  type EffectiveLimits,
  type Kernel,
  type NostrEvent,
  type Ports,
  createKernel,
  finalizeEvent,
  parseConfig,
} from '@beamhop/core';
import { type TestKey, memoryPorts } from '@beamhop/testkit';
import { RELAY_ENGINE_SERVICE, type RelayEngine, relayModule } from '../src/index.ts';

export type Frame = [string, ...unknown[]];

let connSeq = 0;

export class FakeConn implements Connection {
  readonly id: string;
  readonly ipHash = 'iphash';
  readonly userAgent = 'test-agent';
  readonly authed = new Set<string>();
  readonly state = new Map<string, unknown>();
  challenge = '';
  frames: Frame[] = [];
  buffered = 0;
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(
    readonly relayId: string,
    readonly openedAt: number,
  ) {
    this.id = `c${++connSeq}`;
  }

  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as Frame);
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
  /** Return and clear received frames. */
  take(): Frame[] {
    const f = this.frames;
    this.frames = [];
    return f;
  }
  of(type: string): Frame[] {
    return this.frames.filter((f) => f[0] === type);
  }
}

export interface SetupOptions {
  relay?: Record<string, unknown>;
  relayModule?: Record<string, unknown>;
  modules?: BeamhopModule[];
  ports?: Partial<Ports>;
  limits?: Partial<EffectiveLimits>;
}

export type Harness = Awaited<ReturnType<typeof setup>>;

export async function setup(opts: SetupOptions = {}) {
  const ports = memoryPorts(opts.ports);
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.test'], ...opts.relay }],
    modules: opts.relayModule ? { relay: opts.relayModule } : {},
  });
  const kernel: Kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [relayModule, ...(opts.modules ?? [])],
  });
  const engine = kernel.use<RelayEngine>(RELAY_ENGINE_SERVICE)!;
  const base = kernel.limits('main');
  const limitCalls: Array<string | undefined> = [];
  kernel.setLimitsResolver((_relay, tier) => {
    limitCalls.push(tier);
    return { ...base, ...opts.limits };
  });
  let seq = 0;

  const h = {
    kernel,
    ports,
    engine,
    limitCalls,
    async connect(relayId = 'main'): Promise<FakeConn> {
      const c = new FakeConn(relayId, ports.clock.nowMs());
      await engine.open(c);
      return c;
    },
    async send(c: FakeConn, msg: unknown[]): Promise<void> {
      await engine.handle(c, JSON.stringify(msg));
    },
    /** Sign an event with created_at = now by default and unique content. */
    event(
      key: TestKey,
      partial: Partial<Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>> = {},
    ): NostrEvent {
      return finalizeEvent(
        {
          kind: partial.kind ?? 1,
          tags: partial.tags ?? [],
          content: partial.content ?? `note ${++seq}`,
          created_at: partial.created_at ?? ports.clock.now(),
        },
        key.sk,
      );
    },
    /** Publish and return the OK frame. */
    async publish(c: FakeConn, ev: unknown): Promise<Frame> {
      const before = c.frames.length;
      await engine.handle(c, JSON.stringify(['EVENT', ev]));
      const ok = c.frames.slice(before).find((f) => f[0] === 'OK');
      if (!ok) throw new Error(`no OK frame: ${JSON.stringify(c.frames.slice(before))}`);
      return ok;
    },
    /** REQ and return the stored events up to EOSE (frames are consumed). */
    async req(c: FakeConn, subId: string, ...filters: unknown[]): Promise<Frame[]> {
      c.take();
      await engine.handle(c, JSON.stringify(['REQ', subId, ...filters]));
      return c.take();
    },
    authEvent(key: TestKey, c: FakeConn, overrides: { relay?: string; challenge?: string } = {}) {
      return finalizeEvent(
        {
          kind: 22242,
          created_at: ports.clock.now(),
          content: '',
          tags: [
            ['relay', overrides.relay ?? 'wss://relay.test/'],
            ['challenge', overrides.challenge ?? c.challenge],
          ],
        },
        key.sk,
      );
    },
    async auth(c: FakeConn, key: TestKey): Promise<Frame> {
      const ev = h.authEvent(key, c);
      const before = c.frames.length;
      await engine.handle(c, JSON.stringify(['AUTH', ev]));
      return c.frames.slice(before).find((f) => f[0] === 'OK')!;
    },
    record<K extends AppEventName>(name: K): AppEvents[K][] {
      const out: AppEvents[K][] = [];
      kernel.bus.on(name, (p) => out.push(p));
      return out;
    },
  };
  return h;
}

export function eventsOf(frames: Frame[], subId?: string): NostrEvent[] {
  return frames
    .filter((f) => f[0] === 'EVENT' && (subId === undefined || f[1] === subId))
    .map((f) => f[2] as NostrEvent);
}
