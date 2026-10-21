// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cross-shard PubSub over Durable Object-to-Durable Object messaging.
 *
 * Sharding strategy (see README): each virtual relay is served by N `RelayRoom`
 * objects named `<relayId>#<shard>` (N = `RELAY_SHARDS`, default 1). A new WebSocket
 * is assigned to a uniformly random shard. `publish()` delivers to local subscribers
 * synchronously (same semantics as the in-memory adapter) and then POSTs the message
 * once to every *other* shard, which delivers it locally only (no re-forwarding, so no
 * loops). The fan-out target set is narrowed to one relay when a channel segment
 * (split on `: . / #`) equals a configured relay id; otherwise all shards of all relays
 * receive it. Messages must be JSON-serializable.
 */
import type { Logger, PubSub } from '@beamhop/core';
import type { DurableObjectNamespaceLike } from '../cf-types.ts';

export const PUBSUB_PATH = '/__beamhop/pubsub';
export const INTERNAL_ORIGIN = 'https://beamhop.internal';

export function shardName(relayId: string, shard: number): string {
  return `${relayId}#${shard}`;
}

export interface PubSubEnvelope {
  channel: string;
  message: unknown;
  from: string;
}

export interface ShardedPubSubOptions {
  namespace: DurableObjectNamespaceLike;
  /** All configured relay ids (read lazily so config changes apply). */
  relayIds: () => string[];
  shards: number;
  /** This room's shard name; undefined in the Worker. */
  self?: string;
  logger: Logger;
}

export function relayHint(channel: string, relayIds: string[]): string | undefined {
  const parts = new Set(channel.split(/[:./#]/));
  return relayIds.find((id) => parts.has(id));
}

export class ShardedPubSub implements PubSub {
  private readonly subs = new Map<string, Set<(m: unknown) => void>>();

  constructor(private readonly opts: ShardedPubSubOptions) {}

  async publish(channel: string, message: unknown): Promise<void> {
    this.deliverLocal(channel, message);
    const body = JSON.stringify({
      channel,
      message,
      from: this.opts.self ?? 'worker',
    } satisfies PubSubEnvelope);
    const results = await Promise.allSettled(
      this.targets(channel).map(async (name) => {
        const stub = this.opts.namespace.get(this.opts.namespace.idFromName(name));
        const res = await stub.fetch(`${INTERNAL_ORIGIN}${PUBSUB_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (!res.ok) throw new Error(`shard ${name} answered ${res.status}`);
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.opts.logger.log('warn', 'Could not forward a message to another shard', {
          channel,
          error: String(r.reason),
        });
      }
    }
  }

  subscribe(channel: string, handler: (m: unknown) => void): () => void {
    let s = this.subs.get(channel);
    if (!s) {
      s = new Set();
      this.subs.set(channel, s);
    }
    s.add(handler);
    return () => s?.delete(handler);
  }

  /** Shard names that should receive a message on `channel` (excluding self). */
  targets(channel: string): string[] {
    const relays = this.opts.relayIds();
    const hint = relayHint(channel, relays);
    const out: string[] = [];
    for (const relayId of hint ? [hint] : relays) {
      for (let i = 0; i < this.opts.shards; i++) {
        const name = shardName(relayId, i);
        if (name !== this.opts.self) out.push(name);
      }
    }
    return out;
  }

  deliverLocal(channel: string, message: unknown): void {
    for (const h of this.subs.get(channel) ?? []) {
      try {
        h(message);
      } catch (err) {
        this.opts.logger.log('error', 'PubSub handler failed', { channel, error: String(err) });
      }
    }
  }

  /** Handle a forwarded envelope (RelayRoom `POST /__beamhop/pubsub`). */
  async receive(req: Request): Promise<Response> {
    let env: PubSubEnvelope;
    try {
      env = (await req.json()) as PubSubEnvelope;
    } catch {
      return new Response('bad envelope', { status: 400 });
    }
    if (typeof env?.channel !== 'string') return new Response('bad envelope', { status: 400 });
    this.deliverLocal(env.channel, env.message);
    return new Response(null, { status: 204 });
  }
}
