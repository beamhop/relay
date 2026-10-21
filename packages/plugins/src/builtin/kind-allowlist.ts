// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { definePlugin, reject } from '../sdk/index.ts';

const kind = z.number().int().min(0).max(65535);

export const kindAllowlistPlugin = definePlugin({
  id: 'kind-allowlist',
  name: 'Only allow certain kinds of posts',
  description:
    'Accept only the kinds of content you choose (for example profiles, notes and reactions) and turn everything else away.',
  version: '1.0.0',
  permissions: [],
  configSchema: z.object({
    /** Allowed event kinds. */
    kinds: z.array(kind).default([0, 1, 3, 5, 6, 7, 10002]),
    /** Inclusive ranges, e.g. [[30000, 39999]]. */
    ranges: z.array(z.tuple([kind, kind])).default([]),
    message: z.string().max(200).default('this kind of event is not accepted here'),
  }),
  hooks: (api) => {
    const allowed = new Set(api.config.kinds);
    const ranges = api.config.ranges;
    return {
      onEvent(event) {
        if (allowed.has(event.kind)) return;
        if (ranges.some(([lo, hi]) => event.kind >= lo && event.kind <= hi)) return;
        return reject('blocked', `${api.config.message} (kind ${event.kind})`);
      },
    };
  },
});
