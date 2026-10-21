// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type Notification, defineAction, defineModule } from '@beamhop/core';
import { z } from 'zod';
import type { ApprovalsService } from '../src/approvals.ts';
import { complianceInternals } from '../src/module.ts';
import { alice, bob, makeKernel, runAction, viewer } from './helpers.ts';

function restoreModule(calls: unknown[]) {
  return defineModule({
    id: 'test-backups',
    register(k) {
      k.actions.register(
        defineAction({
          id: 'backups.restore',
          title: 'Restore a backup',
          description: 'x',
          scope: 'node',
          permission: 'node.manage',
          input: z.object({ backupId: z.string() }),
          async run(input) {
            calls.push(input);
            return { output: { restored: input.backupId }, summary: 'Restored' };
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'test.sensitive-thing',
          title: 'Do a risky thing',
          description: 'x',
          scope: 'node',
          permission: 'config.write',
          sensitive: true,
          input: z.strictObject({ n: z.number() }),
          async run(input) {
            calls.push(input);
            return { output: { ok: true }, summary: 'Did it' };
          },
        }),
      );
      k.actions.register(
        defineAction({
          id: 'test.plain',
          title: 'Do a normal thing',
          description: 'x',
          scope: 'node',
          permission: 'config.write',
          input: z.object({}),
          async run() {
            calls.push('plain');
            return { output: {}, summary: 'ok' };
          },
        }),
      );
    },
  });
}

async function setup(cfg: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const notes: Notification[] = [];
  const env = await makeKernel({
    modules: { 'enterprise-compliance': cfg },
    extra: [restoreModule(calls)],
  });
  env.kernel.setNotifier(async (n) => {
    notes.push(n);
  });
  const svc = env.kernel.use<ApprovalsService>('enterprise.approvals')!;
  return { ...env, calls, notes, svc };
}

describe('approvals (two-person rule)', () => {
  test('gated action files a request instead of running', async () => {
    const { kernel, calls, notes } = await setup();
    const r = await runAction(
      kernel,
      'backups.restore',
      { backupId: 'b1' },
      alice,
      null,
      'disk died',
    );
    expect(calls).toEqual([]);
    const out = r.output as { status: string; requestId: string };
    expect(out.status).toBe('approval-required');
    expect(out.requestId).toMatch(/^apr_/);
    expect(notes[0]?.title).toBe('Approval needed');
    expect(notes[0]?.category).toBe('safety');
    expect(notes[0]?.body).toContain('disk died');
  });

  test('same admin cannot approve own request', async () => {
    const { kernel, svc } = await setup();
    const r = await runAction(kernel, 'backups.restore', { backupId: 'b1' }, alice);
    const id = (r.output as { requestId: string }).requestId;
    await expect(runAction(kernel, 'approvals.approve', { requestId: id }, alice)).rejects.toThrow(
      /your own/,
    );
    // Same person through an API token principal (same pubkey) is still the requester.
    const token = { ...alice, id: 'token:t1', via: 'token' as const };
    await expect(svc.approve(id, token)).rejects.toThrow();
    expect((await svc.status(id))?.status).toBe('pending');
  });

  test('approver needs the action permission; tokens cannot approve', async () => {
    const { kernel, svc } = await setup();
    const r = await runAction(kernel, 'backups.restore', { backupId: 'b1' }, alice);
    const id = (r.output as { requestId: string }).requestId;
    await expect(svc.approve(id, viewer)).rejects.toThrow(/permission/);
    await expect(svc.approve(id, { ...bob, via: 'token' })).rejects.toThrow(/API token/);
  });

  test('gated action runs once after approval, with identical input', async () => {
    const { kernel, calls, svc } = await setup();
    const r = await runAction(kernel, 'backups.restore', { backupId: 'b1' }, alice);
    const id = (r.output as { requestId: string }).requestId;
    await runAction(kernel, 'approvals.approve', { requestId: id }, bob);
    // Different input → refused.
    await expect(
      runAction(kernel, 'backups.restore', { backupId: 'other', _approvalId: id }, alice),
    ).rejects.toThrow(/different change/);
    // Someone else cannot use Alice's approval.
    await expect(
      runAction(kernel, 'backups.restore', { backupId: 'b1', _approvalId: id }, bob),
    ).rejects.toThrow(/Only the admin who asked/);
    const ok = await runAction(
      kernel,
      'backups.restore',
      { backupId: 'b1', _approvalId: id },
      alice,
    );
    expect(ok.output).toEqual({ restored: 'b1' });
    expect(calls).toEqual([{ backupId: 'b1' }]);
    expect((await svc.status(id))?.status).toBe('used');
    await expect(
      runAction(kernel, 'backups.restore', { backupId: 'b1', _approvalId: id }, alice),
    ).rejects.toThrow(/already used/);
  });

  test('requests and approvals expire', async () => {
    const { kernel, ports, svc } = await setup({
      approvals: { requestTtlMinutes: 10, executeWithinMinutes: 5 },
    });
    const r1 = await runAction(kernel, 'backups.restore', { backupId: 'b1' }, alice);
    const id1 = (r1.output as { requestId: string }).requestId;
    ports.clock.advance(11 * 60);
    await expect(svc.approve(id1, bob)).rejects.toThrow(/expired/);
    expect((await svc.status(id1))?.status).toBe('expired');

    const r2 = await runAction(kernel, 'backups.restore', { backupId: 'b2' }, alice);
    const id2 = (r2.output as { requestId: string }).requestId;
    await svc.approve(id2, bob);
    ports.clock.advance(6 * 60);
    await expect(
      runAction(kernel, 'backups.restore', { backupId: 'b2', _approvalId: id2 }, alice),
    ).rejects.toThrow(/expired/);
  });

  test('denied requests cannot be used; requester may withdraw', async () => {
    const { kernel, svc } = await setup();
    const r = await runAction(kernel, 'backups.restore', { backupId: 'b1' }, alice);
    const id = (r.output as { requestId: string }).requestId;
    await runAction(kernel, 'approvals.deny', { requestId: id, note: 'no' }, bob);
    await expect(
      runAction(kernel, 'backups.restore', { backupId: 'b1', _approvalId: id }, alice),
    ).rejects.toThrow(/not been approved/);
    const r2 = await runAction(kernel, 'backups.restore', { backupId: 'b2' }, alice);
    const id2 = (r2.output as { requestId: string }).requestId;
    await svc.deny(id2, alice);
    expect((await svc.status(id2))?.status).toBe('denied');
  });

  test('sensitive actions are gated (strict schemas too); others untouched; catalog schema flat', async () => {
    const { kernel, calls } = await setup();
    const r = await runAction(kernel, 'test.sensitive-thing', { n: 1 }, alice);
    expect((r.output as { status: string }).status).toBe('approval-required');
    await runAction(kernel, 'test.plain', {}, alice);
    expect(calls).toEqual(['plain']);
    const schema = z.toJSONSchema(kernel.actions.get('test.sensitive-thing')!.input, {
      io: 'input',
      unrepresentable: 'any',
    }) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['_approvalId', 'n']);
    expect(complianceInternals(kernel)?.gate?.wrapped()).toContain('compliance.release-hold');
  });

  test('config change can turn gating off (originals restored)', async () => {
    const { kernel, calls } = await setup();
    const cfg = kernel.config();
    await kernel.applyConfig({
      ...cfg,
      modules: { ...cfg.modules, 'enterprise-compliance': { approvals: { enabled: false } } },
    });
    await runAction(kernel, 'backups.restore', { backupId: 'b9' }, alice);
    expect(calls).toEqual([{ backupId: 'b9' }]);
  });

  test('attention cards offer approve / deny', async () => {
    const { kernel } = await setup();
    await runAction(kernel, 'backups.restore', { backupId: 'b1' }, alice);
    const src = kernel.cards.find((c) => c.id === 'enterprise-compliance.approvals')!;
    const cards = await src.cards(null);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.primary?.actionId).toBe('approvals.approve');
    expect(cards[0]?.secondary?.actionId).toBe('approvals.deny');
  });

  test('check() contract for enterprise-keyvault', async () => {
    const { svc } = await setup();
    const req = { actionId: 'keyvault.escrow-decrypt', input: { dm: 'x' }, principalId: alice.id };
    const first = await svc.check({ ...req, reason: 'subpoena' });
    expect(first.status).toBe('pending');
    const id = first.requestId!;
    expect((await svc.check({ ...req, approvalId: id })).status).toBe('pending');
    await svc.approve(id, bob);
    const ok = await svc.check({ ...req, approvalId: id });
    expect(ok).toEqual({ status: 'approved', requestId: id, approvers: [bob.id] });
    expect((await svc.check({ ...req, approvalId: id })).status).toBe('expired');
    const id2 = (await svc.check(req)).requestId!;
    await svc.deny(id2, bob);
    expect((await svc.check({ ...req, approvalId: id2 })).status).toBe('denied');
  });
});
