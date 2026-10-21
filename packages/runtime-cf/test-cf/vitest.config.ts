// SPDX-License-Identifier: AGPL-3.0-or-later
// Optional: runs runtime-cf inside workerd (real Durable Objects + hibernation API).
// Not part of `bun test`. Run from packages/runtime-cf: `bun run test:cf`.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test-cf/**/*.cf-spec.ts'],
    poolOptions: {
      workers: {
        main: fileURLToPath(new URL('./worker.ts', import.meta.url)),
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: '2025-09-01',
          durableObjects: { RELAY_ROOM: { className: 'RelayRoom', useSQLite: true } },
          bindings: {
            IP_HASH_SALT: 'test-salt',
            BEAMHOP_CONFIG: JSON.stringify({
              relays: [
                { id: 'main', hosts: ['relay.test'] },
                { id: 'other', hosts: ['other.test'] },
              ],
            }),
          },
        },
      },
    },
  },
});
