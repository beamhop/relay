// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type ActionResult, defineAction, defineModule } from '@beamhop/core';
import { z } from 'zod';
import { NODE, bootClaimed, call } from './helpers.ts';

/** Same shape as enterprise-compliance's ApprovalError (matched by name + code). */
class ApprovalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/** A stand-in for an action wrapped by the compliance approval gate. */
const gated = defineModule({
  id: 'test-gated',
  register(k) {
    k.actions.register(
      defineAction({
        id: 'test.gated',
        title: 'Do something sensitive',
        description: 'Needs a second admin.',
        scope: 'node',
        permission: 'config.write',
        sensitive: true,
        input: z.object({ value: z.number().optional(), _approvalId: z.string().optional() }),
        async preview(input) {
          return [{ kind: 'info', text: `approval ${input._approvalId ?? 'none'}` }];
        },
        async run(input): Promise<ActionResult> {
          const id = input._approvalId;
          if (!id)
            return { output: { status: 'approval-required', requestId: 'r1' }, summary: 'asked' };
          if (id.startsWith('err:')) throw new ApprovalError(id.slice(4), `failed: ${id.slice(4)}`);
          return { output: { ran: true, id, value: input.value ?? null }, summary: 'done' };
        },
      }),
    );
  },
});

describe('approval errors and _approvalId', () => {
  test('top-level _approvalId reaches the action input', async () => {
    const env = await bootClaimed([gated]);
    const url = `${NODE}/actions/test.gated`;
    const first = await call(env.kernel, 'POST', url, {
      token: env.ownerToken,
      body: { input: { value: 1 } },
    });
    expect(first.status).toBe(200);
    expect(first.json.output.status).toBe('approval-required');
    const ok = await call(env.kernel, 'POST', url, {
      token: env.ownerToken,
      body: { input: { value: 1 }, _approvalId: 'r1' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.output).toEqual({ ran: true, id: 'r1', value: 1 });
    // Works without an input object too, and in previews.
    const bare = await call(env.kernel, 'POST', url, {
      token: env.ownerToken,
      body: { _approvalId: 'r2' },
    });
    expect(bare.json.output.id).toBe('r2');
    const pv = await call(env.kernel, 'POST', `${url}/preview`, {
      token: env.ownerToken,
      body: { input: {}, _approvalId: 'r3' },
    });
    expect(pv.json.diff[0].text).toBe('approval r3');
  });

  test('ApprovalError codes map to 403/409/410', async () => {
    const env = await bootClaimed([gated]);
    const cases: Array<[string, number]> = [
      ['self_approval', 403],
      ['forbidden', 403],
      ['interactive_only', 403],
      ['not_pending', 409],
      ['not_approved', 409],
      ['mismatch', 409],
      ['expired', 410],
      ['used', 410],
      ['not_found', 410],
    ];
    for (const [code, status] of cases) {
      const r = await call(env.kernel, 'POST', `${NODE}/actions/test.gated`, {
        token: env.ownerToken,
        body: { input: {}, _approvalId: `err:${code}` },
      });
      expect(r.status).toBe(status);
      expect(r.json.error.code).toBe(`approval_${code}`);
      expect(r.json.error.message).toBe(`failed: ${code}`);
    }
    const unknown = await call(env.kernel, 'POST', `${NODE}/actions/test.gated`, {
      token: env.ownerToken,
      body: { input: {}, _approvalId: 'err:weird' },
    });
    expect(unknown.status).toBe(500);
  });
});
