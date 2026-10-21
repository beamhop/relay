// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  blobIndexContract,
  docStoreContract,
  eventStoreContract,
  timeSeriesContract,
} from '@beamhop/testkit';
import { D1Shim } from '../src/d1-shim.ts';
import { type SqlStores, createSqlStores } from '../src/index.ts';

const sqlite = () => createSqlStores({ driver: 'sqlite', path: ':memory:' });
const d1 = () => createSqlStores({ driver: 'd1', d1: new D1Shim() });

const drivers: Array<[string, () => Promise<SqlStores>]> = [
  ['sqlite', sqlite],
  [
    'sqlite (no group commit)',
    () => createSqlStores({ driver: 'sqlite', events: { groupCommit: { enabled: false } } }),
  ],
  [
    'sqlite (group commit window 2 ms)',
    () => createSqlStores({ driver: 'sqlite', events: { groupCommit: { windowMs: 2 } } }),
  ],
  ['d1-shim', d1],
];

const PG_URL = process.env.PG_URL;
if (PG_URL) {
  drivers.push([
    'postgres',
    async () => {
      const stores = await createSqlStores({ driver: 'postgres', url: PG_URL, max: 2 });
      // Fresh schema per store: drop everything owned by this test database.
      await stores.exec.run({
        sql: 'DROP SCHEMA public CASCADE; CREATE SCHEMA public',
        params: [],
      });
      return stores;
    },
  ]);
}

for (const [name, make] of drivers) {
  eventStoreContract(name, async () => (await make()).events);
  blobIndexContract(name, async () => (await make()).blobIndex);
  docStoreContract(name, async () => (await make()).docs);
  timeSeriesContract(name, async () => (await make()).metrics);
}
