// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { NostrEvent } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { wrapEvent } from 'nostr-tools/nip17';
import { fromHex } from '../src/bytes.ts';
import {
  type ApprovalRequest,
  type AuditRecord,
  type DecryptedDm,
  keyvaultRuntime,
} from '../src/index.ts';
import { ctx, runAction, setup } from './helpers.ts';

async function scenario(escrow: Record<string, unknown> = { enabled: true }) {
  const h = await setup({ keyvault: { escrow } });
  const alicePk = await h.svc.ensureKey('google:alice');
  const bob = makeKey(); // self-custody sender
  const wrap = wrapEvent(
    fromHex(bob.sk),
    { publicKey: alicePk },
    'quarterly numbers attached',
  ) as NostrEvent;
  await h.ports.events.save('main', wrap);
  return { ...h, alicePk, bob, wrap };
}

const decrypt = (
  h: Awaited<ReturnType<typeof scenario>>,
  eventId: string,
  reason = 'Legal request #42 from counsel',
) =>
  runAction(
    h.kernel,
    'escrow.decrypt-dm',
    { eventId, reason },
    ctx(h.kernel, 'main', 'token:compliance'),
  );

describe('DM escrow', () => {
  test('decrypts a real NIP-17 DM to a managed key once approved, and audits it', async () => {
    const h = await scenario();
    const requests: ApprovalRequest[] = [];
    let status: 'pending' | 'approved' = 'pending';
    h.kernel.provide('enterprise.approvals', {
      check: async (r: ApprovalRequest) => {
        requests.push(r);
        return {
          status,
          requestId: 'apr-1',
          approvers: status === 'approved' ? ['token:second'] : [],
        };
      },
    });
    await expect(decrypt(h, h.wrap.id)).rejects.toThrow(/Waiting for a second admin.*apr-1/);
    status = 'approved';
    const res = await decrypt(h, h.wrap.id);
    const dm = res.output as DecryptedDm;
    expect(dm).toMatchObject({
      wrapId: h.wrap.id,
      recipient: h.alicePk,
      sender: h.bob.pk,
      kind: 14,
      content: 'quarterly numbers attached',
    });
    expect(requests[0]).toMatchObject({
      actionId: 'escrow.decrypt-dm',
      relayId: 'main',
      principalId: 'token:compliance',
      reason: 'Legal request #42 from counsel',
      input: { eventId: h.wrap.id },
    });
    const audit = await keyvaultRuntime(h.kernel)!.signer.listAudit({ op: 'escrow_decrypt' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      subjectId: 'google:alice',
      principalId: 'token:compliance',
      reason: 'Legal request #42 from counsel',
      eventId: h.wrap.id,
      ok: true,
    } satisfies Partial<AuditRecord>);
    expect(JSON.stringify(audit)).not.toContain('quarterly');
  });

  test('refuses without an approvals service unless explicitly allowed (tests)', async () => {
    const h = await scenario();
    await expect(decrypt(h, h.wrap.id)).rejects.toThrow(/approvals are not set up/);
    const h2 = await scenario({ enabled: true, allowWithoutApprovals: true });
    expect(((await decrypt(h2, h2.wrap.id)).output as DecryptedDm).content).toBe(
      'quarterly numbers attached',
    );
  });

  test('never decrypts DMs of self-custody users', async () => {
    const h = await scenario({ enabled: true, allowWithoutApprovals: true });
    const carol = makeKey(); // self-custody recipient
    const wrap = wrapEvent(fromHex(h.bob.sk), { publicKey: carol.pk }, 'private') as NostrEvent;
    await h.ports.events.save('main', wrap);
    await expect(decrypt(h, wrap.id)).rejects.toThrow(/holds their own key/);
    expect(await h.svc.escrowStatus(carol.pk, 'main')).toEqual({ escrowed: false, managed: false });
  });

  test('is off unless enabled for the relay; escrowStatus drives the client notice', async () => {
    const off = await scenario({ enabled: false, allowWithoutApprovals: true });
    await expect(decrypt(off, off.wrap.id)).rejects.toThrow(/not turned on/);
    expect(await off.svc.escrowStatus(off.alicePk, 'main')).toEqual({
      escrowed: false,
      managed: true,
    });

    const other = await scenario({
      enabled: true,
      relays: ['finance'],
      allowWithoutApprovals: true,
    });
    await expect(decrypt(other, other.wrap.id)).rejects.toThrow(/not turned on/);

    const on = await scenario({ enabled: true, allowWithoutApprovals: true });
    const st = await on.svc.escrowStatus(on.alicePk, 'main');
    expect(st.escrowed).toBe(true);
    expect(st.notice).toMatch(/may be accessed for compliance/);
    await expect(decrypt(on, 'f'.repeat(64))).rejects.toThrow(/not found/);
  });
});
