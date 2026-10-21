// SPDX-License-Identifier: AGPL-3.0-or-later
// Enterprise modules (compliance, network, identity, key vault) inside workerd with real
// D1, R2 and Durable Objects. Run from packages/runtime-cf: `bun run test:workerd`.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export const ENTERPRISE_CONFIG = {
  relays: [{ id: 'main', hosts: ['relay.test'] }],
  modules: {
    'enterprise-compliance': {
      siem: {
        intervalSeconds: 60,
        sinks: [
          {
            id: 'hook',
            type: 'webhook',
            url: 'https://siem.example/ingest',
            secret: 'test-webhook-secret',
          },
        ],
      },
      holds: { refreshSeconds: 10 },
    },
    'enterprise-network': {
      denylist: { all: ['203.0.113.0/24'] },
      outbound: { default: [], groups: { team1: ['wss://partner.example'] } },
    },
    'enterprise-identity': { enabled: true },
    'enterprise-keyvault': { kek: { provider: 'local', keyEnv: 'BEAMHOP_MASTER_KEY' } },
  },
};

export default defineWorkersConfig({
  test: {
    include: ['test-cf/**/*.enterprise-spec.ts'],
    poolOptions: {
      workers: {
        main: fileURLToPath(new URL('./enterprise-worker.ts', import.meta.url)),
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: '2025-09-01',
          durableObjects: { RELAY_ROOM: { className: 'RelayRoom', useSQLite: true } },
          d1Databases: ['DB'],
          r2Buckets: ['BLOBS'],
          bindings: {
            IP_HASH_SALT: 'test-salt',
            BEAMHOP_MASTER_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
            BEAMHOP_CONFIG: JSON.stringify(ENTERPRISE_CONFIG),
          },
        },
      },
    },
  },
});
