// SPDX-License-Identifier: AGPL-3.0-or-later
// Worker entry for the enterprise workerd suite (`bun run test:workerd`). Mirrors what the
// generated build entry does (static builtins), with the enterprise packages bundled.
import * as adminApi from '@beamhop/admin-api';
import * as compliance from '@beamhop/enterprise-compliance';
import * as identity from '@beamhop/enterprise-identity';
import * as keyvault from '@beamhop/enterprise-keyvault';
import * as policy from '@beamhop/policy';
import * as relay from '@beamhop/relay';
import { createCloudflareRuntime } from '../src/index.ts';

/** Every log line the runtime writes (assertions on claim-code and raw-IP logging). */
export const logs: string[] = [];

export const runtime = createCloudflareRuntime({
  builtins: {
    '@beamhop/relay': relay,
    '@beamhop/policy': policy,
    '@beamhop/admin-api': adminApi,
    '@beamhop/enterprise-compliance': compliance,
    '@beamhop/enterprise-identity': identity,
    '@beamhop/enterprise-keyvault': keyvault,
  },
  logSink: (line) => {
    logs.push(line);
  },
});

export default runtime.worker;
export class RelayRoom extends runtime.RelayRoom {}
