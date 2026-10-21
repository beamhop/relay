// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { type PluginApi, definePlugin, reject } from '../sdk/index.ts';

const HEX64 = /^[0-9a-f]{64}$/;

const ConfigSchema = z.object({
  /** Trusted starting points (hex pubkeys), usually the relay owner. */
  seeds: z.array(z.string().regex(HEX64)).min(1),
  /** 0 = seeds only, 1 = + who they follow, 2 = + follows of follows… */
  depth: z.number().int().min(0).max(4).default(2),
  /** Rebuild the trust graph this often (seconds). */
  refreshSeconds: z.number().int().positive().default(3600),
  /** Stop growing the graph past this many people. */
  maxSize: z.number().int().positive().max(2_000_000).default(200_000),
  /** Kinds anyone may publish (e.g. [0] so newcomers can set a profile). */
  exemptKinds: z.array(z.number().int().min(0)).default([]),
  message: z.string().max(200).default("you are not in this relay's web of trust"),
});
type Config = z.infer<typeof ConfigSchema>;

interface Graph {
  members: Set<string>;
  builtAt: number;
}

const BATCH = 250;

/** Breadth-first walk over kind-3 follow lists stored on this relay. */
export async function buildTrustSet(
  api: Pick<PluginApi<unknown>, 'events'>,
  relayId: string,
  c: Pick<Config, 'seeds' | 'depth' | 'maxSize'>,
): Promise<Set<string>> {
  const members = new Set(c.seeds);
  let frontier = [...members];
  for (let d = 0; d < c.depth && frontier.length > 0 && members.size < c.maxSize; d++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += BATCH) {
      const authors = frontier.slice(i, i + BATCH);
      const lists = await api.events.query(
        relayId,
        [{ kinds: [3], authors, limit: authors.length }],
        {
          maxLimit: authors.length,
        },
      );
      for (const ev of lists) {
        for (const t of ev.tags) {
          const pk = t[1];
          if (t[0] !== 'p' || !pk || !HEX64.test(pk) || members.has(pk)) continue;
          if (members.size >= c.maxSize) break;
          members.add(pk);
          next.push(pk);
        }
      }
    }
    frontier = next;
  }
  return members;
}

export const wotStrictPlugin = definePlugin({
  id: 'wot-strict',
  name: 'Only people in your web of trust',
  description:
    'Accept posts only from people you follow, the people they follow, and so on up to the depth you choose.',
  version: '1.0.0',
  permissions: ['read-events'],
  configSchema: ConfigSchema,
  hooks: (api) => {
    const c = api.config;
    const graphs = new Map<string, Graph>();
    const building = new Map<string, Promise<Graph>>();
    const exempt = new Set(c.exemptKinds);

    const build = (relayId: string): Promise<Graph> => {
      let p = building.get(relayId);
      if (!p) {
        p = buildTrustSet(api, relayId, c)
          .then((members) => {
            const g = { members, builtAt: api.clock.now() };
            graphs.set(relayId, g);
            return g;
          })
          .finally(() => building.delete(relayId));
        building.set(relayId, p);
      }
      return p;
    };

    const graphFor = async (relayId: string): Promise<Graph> => {
      const g = graphs.get(relayId);
      if (!g) return build(relayId);
      if (api.clock.now() - g.builtAt >= c.refreshSeconds) {
        // Stale: refresh in the background, keep using the current graph.
        build(relayId).catch((err) =>
          api.log('warn', 'web of trust refresh failed', { err: String(err) }),
        );
      }
      return g;
    };

    return {
      async onEvent(event, ctx) {
        if (exempt.has(event.kind)) return;
        const g = await graphFor(ctx.relayId);
        if (g.members.has(event.pubkey)) return;
        return reject('restricted', c.message);
      },
    };
  },
});
