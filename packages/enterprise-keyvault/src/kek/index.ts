// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FetchLike } from '../bytes.ts';
import type { KekConfig } from '../config.ts';
import {
  AwsKmsWrapper,
  AzureKeyVaultWrapper,
  GcpKmsWrapper,
  VaultTransitWrapper,
} from './cloud.ts';
import { LocalMasterKeyWrapper } from './local.ts';
import type { KekProvider } from './types.ts';

export * from './cloud.ts';
export * from './local.ts';
export * from './types.ts';

export interface KekDeps {
  fetch: FetchLike;
  nowMs: () => number;
  /** Environment lookup for `keyEnv` (defaults to `process.env` when the runtime has one). */
  env?: (name: string) => string | undefined;
  /** File reader for `keyFile` (runtime-specific; injected). */
  readFile?: (path: string) => Promise<string>;
}

export function defaultEnv(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}

export async function createKek(cfg: KekConfig, deps: KekDeps): Promise<KekProvider> {
  switch (cfg.provider) {
    case 'local': {
      let s = cfg.key;
      if (!s && cfg.keyEnv) s = (deps.env ?? defaultEnv)(cfg.keyEnv);
      if (!s && cfg.keyFile) {
        if (!deps.readFile)
          throw new Error('Reading the master key from a file is not supported on this runtime');
        s = await deps.readFile(cfg.keyFile);
      }
      if (!s) throw new Error('No master key configured (set kek.key, kek.keyEnv or kek.keyFile)');
      return LocalMasterKeyWrapper.fromString(s);
    }
    case 'aws-kms':
      return new AwsKmsWrapper({ ...cfg, fetch: deps.fetch });
    case 'gcp-kms':
      return new GcpKmsWrapper({ ...cfg, fetch: deps.fetch, nowMs: deps.nowMs });
    case 'azure-keyvault':
      return new AzureKeyVaultWrapper({ ...cfg, fetch: deps.fetch, nowMs: deps.nowMs });
    case 'vault-transit':
      return new VaultTransitWrapper({ ...cfg, fetch: deps.fetch });
  }
}
