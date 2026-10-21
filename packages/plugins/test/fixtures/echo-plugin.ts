// SPDX-License-Identifier: AGPL-3.0-or-later
// Test fixture: an "untrusted" plugin exercising the sandbox.
import { z } from 'zod';
import { definePlugin, reject } from '../../src/sdk/index.ts';

export default definePlugin({
  id: 'echo',
  name: 'Echo test plugin',
  description: 'Behaves according to the post content (tests only).',
  version: '1.2.3',
  permissions: ['read-events'],
  configSchema: z.object({ word: z.string().default('bad') }),
  hooks: (api) => ({
    async onEvent(event, ctx) {
      const c = event.content;
      if (c === api.config.word) return reject('blocked', `no ${api.config.word}`);
      if (c === 'count') {
        const n = await api.events.count(ctx.relayId, [{ kinds: [1] }]);
        return reject('blocked', `count=${n}`);
      }
      if (c === 'env') return reject('blocked', `env=${Object.keys(process.env).length}`);
      if (c === 'net') {
        try {
          await fetch('https://example.com/');
          return reject('blocked', 'net=allowed');
        } catch (err) {
          return reject('blocked', `net=${(err as Error).message}`);
        }
      }
      if (c === 'docs') {
        try {
          await api.docs.put('k', 1);
          return reject('blocked', 'docs=allowed');
        } catch (err) {
          return reject('blocked', `docs=${(err as Error).message}`);
        }
      }
      if (c === 'conn') return reject('blocked', `conn=${ctx.conn?.id}:${ctx.conn?.authed.length}`);
      if (c === 'slow') {
        const until = Date.now() + 150;
        while (Date.now() < until) {
          // busy
        }
        return;
      }
      if (c === 'loop') {
        while (true) {
          // stuck forever
        }
      }
      if (c === 'throw') throw new Error('boom');
    },
    onReq(filters) {
      if (filters.some((f) => f.kinds?.includes(4))) return reject('restricted', 'no DMs');
    },
  }),
});
