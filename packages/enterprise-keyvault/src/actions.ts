// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ActionDef, defineAction } from '@beamhop/core';
import { z } from 'zod';
import { requireApproval } from './escrow.ts';
import type { KeyvaultRuntime } from './runtime.ts';
import type { AuditOp } from './signer.ts';

const HEX64 = /^[0-9a-f]{64}$/;

export function createActions(rt: KeyvaultRuntime): ActionDef[] {
  const status = defineAction({
    id: 'keyvault.status',
    title: 'Show key vault status',
    description:
      'Where the master key lives, how many company-managed keys exist, and pending work.',
    technical: 'KEK provider/id, DEK count and rotation state, managed key counts (keyvault.keys).',
    scope: 'node',
    permission: 'compliance.read',
    input: z.object({}),
    readOnly: true,
    keywords: ['kms', 'master key', 'managed keys', 'bunker'],
    async run() {
      const deks = await rt.envelope.listDeks().catch(() => []);
      const current = rt.current?.id ?? null;
      const output = {
        provider: rt.current?.provider ?? null,
        kekId: current,
        ready: !!rt.current,
        error: rt.initError,
        dataKeys: deks.length,
        pendingRotation: deks.filter((d) => d.kekId !== current).length,
        keys: await rt.signer.counts(),
        bunkerPubkey: rt.bunker.knownPubkey(),
        escrowEnabled: rt.cfg().escrow.enabled,
        signing: { ...rt.signer.stats },
      };
      return {
        output,
        summary: `${output.keys.active} company-managed keys; master key in ${output.provider ?? 'nowhere (not ready)'}`,
      };
    },
  });

  const rotateKek = defineAction({
    id: 'keyvault.rotate-kek',
    title: 'Switch to the new master key',
    description:
      'Re-wraps every data key with the master key currently configured. Keep the old one under "previous keys" until this finishes.',
    technical:
      'Envelope KEK rotation: unwrap each DEK (keyvault.deks) with its recorded KEK, wrap with the current KEK. `force` re-wraps DEKs already under the current KEK id (cloud KMS key-version rotation).',
    scope: 'node',
    permission: 'node.manage',
    sensitive: true,
    input: z.object({
      force: z.boolean().default(false),
      approvalId: z
        .string()
        .optional()
        .describe('Approved request id (when the approval gate does not wrap this action)'),
    }),
    keywords: ['kms', 'rotate', 'master key', 'kek'],
    async preview(input) {
      const deks = await rt.envelope.listDeks();
      const id = rt.current?.id;
      const n = input.force ? deks.length : deks.filter((d) => d.kekId !== id).length;
      return [
        {
          kind: 'change',
          text: `${n} data key${n === 1 ? '' : 's'} will be re-wrapped with the current master key`,
          technical: `KEK → ${id ?? 'unavailable'}`,
        },
      ];
    },
    async run(input, ctx) {
      await requireApproval(
        rt.kernel,
        {
          actionId: 'keyvault.rotate-kek',
          relayId: null,
          principalId: ctx.principal.id,
          input: { force: input.force },
          ...(ctx.reason ? { reason: ctx.reason } : {}),
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        true,
      );
      const report = await rt.rotateKek(input.force);
      if (report.failed.length)
        throw new Error(
          `${report.failed.length} data key(s) could not be re-wrapped: ${report.failed.map((f) => `${f.tenant}: ${f.error}`).join('; ')}`,
        );
      return { output: report, summary: `Re-wrapped ${report.rewrapped} data key(s)` };
    },
  });

  const wrapLegacy = defineAction({
    id: 'keyvault.wrap-legacy-keys',
    title: 'Protect older server keys with the master key',
    description: 'Encrypts keys the server stored before the key vault was turned on.',
    technical:
      'Re-wraps alerts.keys/nostr ({sk}) and, when asked, relay.groups.key/<relay> ({secretKey}) through ports.keyWrapper.',
    scope: 'node',
    permission: 'node.manage',
    input: z.object({ relayGroupKeys: z.boolean().optional() }),
    async run(input) {
      const report = await rt.migrateLegacy(
        input.relayGroupKeys !== undefined ? { relayGroupKeys: input.relayGroupKeys } : {},
      );
      return { output: report, summary: `Protected ${report.wrapped.length} older key(s)` };
    },
  });

  const destroyKey = defineAction({
    id: 'keyvault.destroy-key',
    title: 'Destroy a company-managed key',
    description:
      'Permanently erases the person’s private key after a waiting period. Their old posts stay, but nobody can sign as them again. Blocked by legal holds.',
    technical: 'Crypto-shred: deletes wrappedSk from keyvault.keys after the grace period.',
    scope: 'node',
    permission: 'compliance.write',
    sensitive: true,
    input: z.object({
      subjectId: z.string().min(1),
      afterDays: z.number().int().min(0).optional(),
      reason: z.string().min(3),
      approvalId: z
        .string()
        .optional()
        .describe('Approved request id (when the approval gate does not wrap this action)'),
    }),
    async preview(input) {
      const rec = await rt.signer.record(input.subjectId);
      if (!rec) return [{ kind: 'info', text: 'This person has no company-managed key' }];
      const days = input.afterDays ?? rt.cfg().destroyGraceDays;
      return [
        {
          kind: 'warning',
          text:
            days === 0
              ? 'The key will be destroyed now. This cannot be undone.'
              : `The key will be destroyed in ${days} day(s). You can cancel until then.`,
          technical: `pubkey ${rec.pubkey}`,
        },
      ];
    },
    async run(input, ctx) {
      await requireApproval(
        rt.kernel,
        {
          actionId: 'keyvault.destroy-key',
          relayId: null,
          principalId: ctx.principal.id,
          input: {
            subjectId: input.subjectId,
            reason: input.reason,
            ...(input.afterDays !== undefined ? { afterDays: input.afterDays } : {}),
          },
          reason: input.reason,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        true,
      );
      const res = await rt.signer.destroyKey(input.subjectId, {
        afterSeconds: (input.afterDays ?? rt.cfg().destroyGraceDays) * 86400,
        reason: input.reason,
        principalId: ctx.principal.id,
      });
      const summary =
        res.status === 'destroyed'
          ? 'Destroyed the key'
          : res.status === 'held'
            ? 'A legal hold blocks destroying this key; it will be destroyed when the hold ends'
            : res.status === 'scheduled'
              ? 'Scheduled the key for destruction'
              : 'No key to destroy';
      return { output: res, summary };
    },
  });

  const cancelDestroy = defineAction({
    id: 'keyvault.cancel-destroy',
    title: 'Keep a company-managed key',
    description: 'Cancels a scheduled key destruction.',
    scope: 'node',
    permission: 'compliance.write',
    input: z.object({ subjectId: z.string().min(1) }),
    async run(input, ctx) {
      const ok = await rt.signer.cancelDestroy(input.subjectId, ctx.principal.id);
      return { output: { cancelled: ok }, summary: ok ? 'Key kept' : 'Nothing was scheduled' };
    },
  });

  const revokeSessions = defineAction({
    id: 'keyvault.revoke-sessions',
    title: 'Sign a person out of all apps',
    description: 'Disconnects every app that signs through the company bunker for this person.',
    technical: 'Revokes NIP-46 bunker sessions and unbinds client pubkeys.',
    scope: 'node',
    permission: 'users.write',
    input: z.object({ subjectId: z.string().min(1) }),
    async run(input) {
      const n = await rt.bunker.revokeSessions(input.subjectId);
      return { output: { revoked: n }, summary: `Signed out of ${n} session(s)` };
    },
  });

  const audit = defineAction({
    id: 'keyvault.audit',
    title: 'Show signing history',
    description: 'Every signature, decryption and key change made with company-managed keys.',
    technical: 'keyvault.audit records (who, kind, client, session).',
    scope: 'node',
    permission: 'compliance.read',
    readOnly: true,
    input: z.object({
      subjectId: z.string().optional(),
      op: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    async run(input) {
      const items = await rt.signer.listAudit({
        limit: input.limit,
        ...(input.subjectId ? { subjectId: input.subjectId } : {}),
        ...(input.op ? { op: input.op as AuditOp } : {}),
      });
      return { output: items, summary: `${items.length} record(s)` };
    },
  });

  const decryptDm = defineAction({
    id: 'escrow.decrypt-dm',
    title: 'Open a private message for compliance',
    description:
      'Reads one private message of a person with a company-managed key, for a legal or compliance request. Needs a reason and a second admin’s approval, and is logged.',
    technical:
      'NIP-17 escrow: unwrap gift wrap 1059 → seal 13 → rumor 14/15 with the recipient’s managed key. Never possible for self-custody keys.',
    scope: 'relay',
    permission: 'compliance.write',
    sensitive: true,
    input: z.object({
      eventId: z.string().regex(HEX64, 'expected a 64-character event id'),
      reason: z.string().min(10, 'Please describe the legal or compliance reason'),
      approvalId: z.string().optional(),
    }),
    async preview(input) {
      return [
        {
          kind: 'warning',
          text: 'You are about to read someone’s private message. This is recorded with your reason.',
          technical: `escrow decrypt of ${input.eventId}`,
        },
      ];
    },
    async run(input, ctx) {
      if (!ctx.relayId) throw new Error('Pick a relay');
      await requireApproval(
        rt.kernel,
        {
          actionId: 'escrow.decrypt-dm',
          relayId: ctx.relayId,
          principalId: ctx.principal.id,
          input: { eventId: input.eventId },
          reason: input.reason,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        rt.cfg().escrow.allowWithoutApprovals,
      );
      const dm = await rt.escrow.decryptDm(
        ctx.relayId,
        input.eventId,
        input.reason,
        ctx.principal.id,
      );
      return { output: dm, summary: 'Opened one private message for compliance' };
    },
  });

  return [
    status,
    rotateKek,
    wrapLegacy,
    destroyKey,
    cancelDestroy,
    revokeSessions,
    audit,
    decryptDm,
  ] as unknown as ActionDef[];
}
