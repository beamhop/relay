// SPDX-License-Identifier: AGPL-3.0-or-later
/** People bulk actions, block "Why?", row lens, and Security (recovery checklist, tokens). */
import { describe, expect, it } from 'vitest';
import type { BulkResult, RunResult } from '../src/lib/api/types.ts';
import {
  BULK,
  type BulkApi,
  inputsFor,
  mergeDiffs,
  rangeSelect,
  runBulk,
  undoAll,
} from '../src/lib/components/people/bulk.ts';
import { isRestricted, userLensLines } from '../src/lib/components/people/users.ts';
import {
  daysLeft,
  recoveryChecklist,
  scopeLabel,
  sortTokens,
  tokenState,
} from '../src/routes/settings/security/security.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('bulk inputs', () => {
  it('builds one input per person over the single actions', () => {
    expect(inputsFor(BULK.ban, [A, B])).toEqual([{ pubkeys: [A] }, { pubkeys: [B] }]);
    expect(BULK.mute.actionId).toBe('moderation.mute-pubkey');
    expect(BULK.unallow.actionId).toBe('access.remove-allowlist');
    expect(inputsFor(BULK.tier, [A], { tier: 'plus' })).toEqual([{ pubkey: A, tier: 'plus' }]);
    expect(inputsFor(BULK.tier, [A])).toEqual([{ pubkey: A, tier: null }]);
    expect(BULK.ban.all?.([A, B])).toEqual({ pubkeys: [A, B] });
    expect(BULK.tier.all).toBeUndefined();
  });

  it('merges identical diff lines with a count and caps the list', () => {
    const line = { kind: 'change' as const, text: 'moves to Plus' };
    const r = mergeDiffs([[line], [line], [{ kind: 'warning', text: 'x' }]]);
    expect(r.lines).toEqual([
      { kind: 'change', text: 'moves to Plus (×2)' },
      { kind: 'warning', text: 'x' },
    ]);
    const many = mergeDiffs(
      Array.from({ length: 12 }, (_, i) => [{ kind: 'add' as const, text: `p${i}` }]),
      8,
    );
    expect(many.lines).toHaveLength(8);
    expect(many.more).toBe(4);
  });
});

function fakeApi(fail: Set<number> = new Set()) {
  const calls: string[] = [];
  let n = 0;
  const api: BulkApi = {
    async bulk(id, inputs): Promise<BulkResult> {
      calls.push(`bulk ${id} ${inputs.length}`);
      return {
        results: inputs.map((_, i) =>
          fail.has(i) ? { ok: false, error: { code: 'x', message: `no ${i}` } } : { ok: true },
        ),
        summary: 'done',
        undo: { token: 'T', expiresAt: 100 },
      };
    },
    async run<O>(id: string): Promise<RunResult<O>> {
      const i = n++;
      calls.push(`run ${id} ${i}`);
      if (fail.has(i)) throw new Error(`no ${i}`);
      return { output: {} as O, summary: 'ok', undo: { token: `t${i}`, expiresAt: 200 - i } };
    },
  };
  return { api, calls };
}

describe('runBulk', () => {
  it('uses the bulk endpoint (one undo) when the action supports it', async () => {
    const { api, calls } = fakeApi(new Set([1]));
    const out = await runBulk(api, 'moderation.ban-pubkey', [{}, {}, {}], { bulk: true });
    expect(calls).toEqual(['bulk moderation.ban-pubkey 3']);
    expect(out).toEqual({
      done: 2,
      failed: [{ index: 1, message: 'no 1' }],
      undoTokens: ['T'],
      undoExpiresAt: 100,
    });
  });

  it('falls back to one-by-one runs and keeps every undo token', async () => {
    const { api, calls } = fakeApi(new Set([1]));
    const out = await runBulk(api, 'users.set-tier', [{}, {}, {}], { bulk: false });
    expect(calls).toHaveLength(3);
    expect(out.done).toBe(2);
    expect(out.failed).toEqual([{ index: 1, message: 'no 1' }]);
    expect(out.undoTokens).toEqual(['t0', 't2']);
    expect(out.undoExpiresAt).toBe(198);
    const undone: string[] = [];
    expect(await undoAll(async (t) => undone.push(t), out.undoTokens)).toBe(2);
    expect(undone).toEqual(['t2', 't0']);
  });
});

describe('runBulk for plans', () => {
  it('always uses the bulk endpoint for plans', async () => {
    expect(BULK.tier.bulk).toBe(true);
    const { api, calls } = fakeApi();
    const out = await runBulk(api, 'users.set-tier', [{}, {}], { bulk: BULK.tier.bulk ?? false });
    expect(calls).toEqual(['bulk users.set-tier 2']);
    expect(out.undoTokens).toEqual(['T']);
  });

  it('falls back to one-by-one only when the server refuses bulk (4xx)', async () => {
    const refusing = (status: number) => {
      const { api, calls } = fakeApi();
      api.bulk = async () => {
        calls.push('bulk');
        throw Object.assign(new Error('not bulk'), { status });
      };
      return { api, calls };
    };
    const a = refusing(400);
    const out = await runBulk(a.api, 'users.set-tier', [{}, {}], { bulk: true });
    expect(a.calls).toEqual(['bulk', 'run users.set-tier 0', 'run users.set-tier 1']);
    expect(out.undoTokens).toEqual(['t0', 't1']);
    const b = refusing(503);
    await expect(runBulk(b.api, 'users.set-tier', [{}], { bulk: true })).rejects.toThrow(
      'not bulk',
    );
    expect(b.calls).toEqual(['bulk']);
  });
});

describe('selection', () => {
  it('shift-click selects a range from the anchor', () => {
    const order = [A, B, C, 'd'];
    expect([...rangeSelect(order, new Set([A]), A, C)].sort()).toEqual([A, B, C].sort());
    expect([...rangeSelect(order, new Set(), C, A)].sort()).toEqual([A, B, C].sort());
    // Without an anchor it toggles.
    expect([...rangeSelect(order, new Set([B]), null, B)]).toEqual([]);
  });
});

describe('people rows', () => {
  it('knows who is held back here', () => {
    expect(isRestricted({ pubkey: A, banned: true })).toBe(true);
    expect(isRestricted({ pubkey: A, muted: true })).toBe(true);
    expect(isRestricted({ pubkey: A, allowlisted: false }, 'open')).toBe(false);
    expect(isRestricted({ pubkey: A, allowlisted: false }, 'allowlist')).toBe(true);
    expect(isRestricted({ pubkey: A, allowlisted: false, admin: true }, 'allowlist')).toBe(false);
  });

  it('puts npub, hex, tier id and raw quotas in the lens', () => {
    const lines = userLensLines({
      pubkey: A,
      tier: 'plus',
      tierExplicit: true,
      quotaBytes: 100,
      usedBytes: 40,
      remainingBytes: 60,
      banned: true,
    });
    expect(lines[0]).toMatch(/^npub1/);
    expect(lines).toContain(`hex ${A}`);
    expect(lines).toContain('tier plus (explicit)');
    expect(lines).toContain('quotaBytes 100');
    expect(lines).toContain('usedBytes 40');
    expect(lines).toContain('remainingBytes 60');
    expect(lines).toContain('in policy.bans');
  });
});

describe('security', () => {
  const owner = { id: A, displayName: 'Ayşe' };

  it('recovery checklist: codes saved, a second owner, a passkey', () => {
    const one = recoveryChecklist(
      { owner: true, owners: [owner], recoveryCodesLeft: 10, passkeys: 0 },
      false,
    );
    expect(one.map((c) => [c.id, c.done])).toEqual([
      ['codes', false],
      ['owner', false],
      ['passkey', false],
    ]);
    const all = recoveryChecklist(
      {
        owner: true,
        owners: [owner, { id: B, displayName: 'Deniz' }],
        recoveryCodesLeft: 3,
        passkeys: 1,
      },
      true,
    );
    expect(all.every((c) => c.done)).toBe(true);
    expect(
      recoveryChecklist(
        { owner: true, owners: [owner], recoveryCodesLeft: 0, passkeys: 0 },
        true,
      )[0]?.done,
    ).toBe(false);
  });

  it('scopes in plain words, raw strings pass through', () => {
    expect(scopeLabel('moderation.write')).toBe('moderate posts and people');
    expect(scopeLabel('relay.read')).toBe('see everything');
    expect(scopeLabel('custom.scope')).toBe('custom.scope');
  });

  it('token state, days left and order', () => {
    const now = 1_000_000;
    expect(tokenState({ expiresAt: now - 1 }, now)).toBe('expired');
    expect(tokenState({ expiresAt: now + 3 * 86400 }, now)).toBe('soon');
    expect(tokenState({ expiresAt: now + 30 * 86400 }, now)).toBe('active');
    expect(daysLeft(now + 90 * 86400, now)).toBe(90);
    const t = (id: string, createdAt: number, expiresAt: number) => ({
      id,
      name: id,
      scopes: [],
      createdAt,
      expiresAt,
    });
    expect(
      sortTokens([t('old', 1, now + 999), t('dead', 5, now - 1), t('new', 3, now + 999)], now).map(
        (x) => x.id,
      ),
    ).toEqual(['new', 'old', 'dead']);
  });
});
