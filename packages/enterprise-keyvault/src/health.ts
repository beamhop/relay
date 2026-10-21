// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttentionCard, CardSource, HealthCheck } from '@beamhop/core';
import type { KeyvaultRuntime } from './runtime.ts';

export function createHealthChecks(rt: KeyvaultRuntime): HealthCheck[] {
  const kek: HealthCheck = {
    id: 'keyvault.kek',
    subsystem: 'security',
    weight: 3,
    async run() {
      const p = await rt.probeKek();
      if (p.ok)
        return {
          score: 100,
          status: 'ok',
          message: 'The master key is reachable',
          technical: `KEK ${rt.current?.id}`,
        };
      return {
        score: 0,
        status: 'critical',
        message: 'The master key cannot be reached: company-managed keys cannot sign',
        technical: p.error ?? 'unknown error',
      };
    },
  };
  const signer: HealthCheck = {
    id: 'keyvault.signer',
    subsystem: 'security',
    weight: 1,
    async run() {
      const counts = await rt.signer.counts();
      const { signed, errors, rateLimited } = rt.signer.stats;
      const total = signed + errors;
      const rate = total ? errors / total : 0;
      const technical = `keys active=${counts.active} pending=${counts['pending-destroy']} destroyed=${counts.destroyed}; signed=${signed} errors=${errors} rateLimited=${rateLimited}`;
      if (total >= 10 && rate > 0.25)
        return {
          score: 40,
          status: 'warn',
          message: 'Many signing requests are failing',
          technical,
        };
      return {
        score: 100,
        status: 'ok',
        message: `${counts.active} company-managed key${counts.active === 1 ? '' : 's'}`,
        technical,
      };
    },
  };
  return [kek, signer];
}

export function createCardSource(rt: KeyvaultRuntime): CardSource {
  return {
    id: 'keyvault',
    async cards(relayId) {
      if (relayId !== null) return [];
      const now = rt.kernel.ports.clock.now();
      const out: AttentionCard[] = [];
      if (!rt.current) {
        out.push({
          id: 'keyvault.not-ready',
          relayId: null,
          severity: 'critical',
          title: 'The key vault has no master key',
          body: 'Company-managed keys cannot sign until the master key is configured.',
          ...(rt.initError ? { technical: rt.initError } : {}),
          createdAt: now,
        });
        return out;
      }
      if (rt.current.provider === 'local')
        out.push({
          id: 'keyvault.local-kek',
          relayId: null,
          severity: 'info',
          title: 'Master key is stored on disk — consider a cloud KMS',
          body: 'Anyone who copies this server’s settings and database could unlock the company keys. A cloud key service (AWS, Google Cloud, Azure, Vault) keeps the master key off the server.',
          technical: `KEK ${rt.current.id}; supported: aws-kms, gcp-kms, azure-keyvault, vault-transit`,
          batchKey: 'keyvault.local-kek',
          createdAt: now,
        });
      const pending = await rt.envelope.pendingRotation().catch(() => 0);
      if (pending > 0)
        out.push({
          id: 'keyvault.rotation-pending',
          relayId: null,
          severity: 'warning',
          title: 'Finish switching to the new master key',
          body: `${pending} data key(s) still use the previous master key. Keep it configured until this is done.`,
          technical: `${pending} DEK(s) not wrapped by ${rt.current.id}`,
          createdAt: now,
          primary: { label: 'Switch now', actionId: 'keyvault.rotate-kek', input: {} },
        });
      const held = await rt.signer.heldCount();
      if (held)
        out.push({
          id: 'keyvault.destroy-held',
          relayId: null,
          severity: 'info',
          title: 'A legal hold is keeping a key from being destroyed',
          body: 'It will be destroyed automatically once the hold is released.',
          createdAt: now,
        });
      return out;
    },
  };
}
