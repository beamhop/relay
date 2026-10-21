// SPDX-License-Identifier: AGPL-3.0-or-later
/** Plugin writer (§6.5.4): state machine, parsing of the generated plugin, AI marker, deferred discard. */
import { describe, expect, it, vi } from 'vitest';
import {
  DeferredDiscard,
  type GeneratePluginOutput,
  type WriterState,
  aiMarked,
  canGenerate,
  declaredPermissions,
  enableBlock,
  initialState,
  isCurrentRun,
  markAi,
  needsApproval,
  pluginHooks,
  pluginInfo,
  reduce,
  stepsLine,
  testCases,
  testCounts,
  testNames,
  writtenByAssistant,
} from '../src/lib/components/plugins/writer';

const CODE = `import { definePlugin } from '@beamhop/plugins/sdk';
export default definePlugin({
  id: 'ai-links',
  name: 'Limit links from newcomers',
  description: 'Refuses posts with more than 5 links from people who joined this week',
  permissions: ['read-events'],
  priority: 300,
  onEvent(event, ctx) { return { action: 'accept' }; },
});`;
const TESTS = `import { describe, expect, test } from 'bun:test';
describe('ai-links', () => {
  test('blocks a post with 6 links', async () => {});
  test("lets a normal post through", async () => {});
  it('ignores old accounts', async () => {});
});`;

const ok = (o: Partial<GeneratePluginOutput> = {}): GeneratePluginOutput => ({
  id: 'ai-links',
  code: CODE,
  tests: TESTS,
  tested: true,
  testResult: { ok: true, passed: 3, failed: 0, output: '' },
  installed: true,
  enabled: false,
  problems: [],
  note: 'Installed turned OFF.',
  ...o,
});

const DESC = 'Refuse posts with more than 5 links';

function generating(): Extract<WriterState, { phase: 'generating' }> {
  const s = reduce(initialState(DESC), { type: 'generate', now: 1 });
  if (s.phase !== 'generating') throw new Error('not generating');
  return s;
}

describe('writer state machine', () => {
  it('needs a description of at least 10 characters', () => {
    expect(canGenerate('too short')).toBe(false);
    expect(canGenerate(DESC)).toBe(true);
    expect(reduce(initialState('short'), { type: 'generate', now: 1 }).phase).toBe('idle');
  });

  it('idle → generating → result → enabled', () => {
    const g = generating();
    expect(g.description).toBe(DESC);
    const r = reduce(g, { type: 'success', runId: g.runId, output: ok() });
    expect(r.phase).toBe('result');
    const e = reduce(r, { type: 'enabled' });
    expect(e.phase).toBe('enabled');
    expect(reduce(e, { type: 'enable-undone' }).phase).toBe('result');
  });

  it('result → discarded, and undo brings the result back', () => {
    const g = generating();
    const r = reduce(g, { type: 'success', runId: g.runId, output: ok() });
    const d = reduce(r, { type: 'discarded' });
    expect(d.phase).toBe('discarded');
    expect(reduce(d, { type: 'discard-undone' }).phase).toBe('result');
  });

  it('errors and unusable output go to failed; failed can generate again', () => {
    const g = generating();
    const f = reduce(g, { type: 'error', runId: g.runId, error: 'The assistant is turned off.' });
    expect(f).toMatchObject({ phase: 'failed', error: 'The assistant is turned off.' });
    const again = reduce(f, { type: 'generate', now: 2 });
    expect(again.phase).toBe('generating');

    const g2 = generating();
    const bad = ok({
      code: '',
      problems: ['The model did not return a plugin and tests'],
      installed: false,
      tested: false,
      note: 'Could not.',
    });
    expect(reduce(g2, { type: 'success', runId: g2.runId, output: bad })).toMatchObject({
      phase: 'failed',
      error: 'Could not.',
    });
  });

  it('never enables a plugin whose tests failed', () => {
    const g = generating();
    const failed = ok({
      installed: false,
      testResult: { ok: false, passed: 2, failed: 1, output: '' },
      note: 'The tests did not pass.',
    });
    const r = reduce(g, { type: 'success', runId: g.runId, output: failed });
    expect(r.phase).toBe('result');
    expect(enableBlock(failed)).toBe('tests-failed');
    expect(reduce(r, { type: 'enabled' }).phase).toBe('result');
    expect(enableBlock(ok({ tested: false, testResult: undefined, installed: false }))).toBe(
      'not-tested',
    );
    expect(enableBlock(ok({ installed: false }))).toBe('not-installed');
    expect(enableBlock(ok())).toBeNull();
  });

  it('cancel returns to idle with the description kept and ignores the late answer', () => {
    const g = generating();
    const c = reduce(g, { type: 'cancel' });
    expect(c).toEqual({ phase: 'idle', description: DESC });
    expect(isCurrentRun(c, g.runId)).toBe(false);
    expect(reduce(c, { type: 'success', runId: g.runId, output: ok() })).toBe(c);
  });

  it('answers from an older run are ignored', () => {
    const g1 = generating();
    const idle = reduce(g1, { type: 'cancel' });
    const g2 = reduce(idle, { type: 'generate', now: 3 });
    expect(reduce(g2, { type: 'success', runId: g1.runId, output: ok() })).toBe(g2);
  });

  it('try again keeps the description; edits are ignored while generating', () => {
    const g = generating();
    expect(reduce(g, { type: 'edit', description: 'x' })).toBe(g);
    expect(reduce(g, { type: 'retry' })).toBe(g);
    const r = reduce(g, { type: 'success', runId: g.runId, output: ok() });
    expect(reduce(r, { type: 'retry' })).toEqual({ phase: 'idle', description: DESC });
    expect(reduce(r, { type: 'reset' })).toEqual(initialState());
  });
});

describe('reading the generated plugin', () => {
  it('finds name, summary, permissions and hooks', () => {
    expect(pluginInfo(ok())).toEqual({
      name: 'Limit links from newcomers',
      summary: 'Refuses posts with more than 5 links from people who joined this week',
    });
    expect(declaredPermissions(ok())).toEqual(['read-events']);
    expect(declaredPermissions(ok({ code: 'definePlugin({})' }))).toEqual([]);
    expect(declaredPermissions(ok({ permissions: ['network', 'bogus'] }))).toEqual(['network']);
    expect(pluginHooks(CODE)).toEqual(['onEvent']);
  });

  it('lists test names from the test file when the run does not name them', () => {
    expect(testNames(TESTS)).toEqual([
      'blocks a post with 6 links',
      'lets a normal post through',
      'ignores old accounts',
    ]);
    expect(testCases(ok()).every((c) => c.ok === true)).toBe(true);
    expect(testCounts(ok())).toEqual({ passed: 3, failed: 0 });
    const unknown = testCases(ok({ testResult: { ok: false, output: 'boom' } }));
    expect(unknown.map((c) => c.ok)).toEqual([null, null, null]);
  });

  it('reads pass/fail per test from bun test output, with failure details', () => {
    const output = [
      '(pass) ai-links > blocks a post with 6 links [0.20ms]',
      'error: expect(received).toBe(expected)',
      'Expected: "accept"',
      'Received: "reject"',
      '(fail) ai-links > lets a normal post through [0.31ms]',
      '(pass) ai-links > ignores old accounts',
      ' 2 pass',
      ' 1 fail',
    ].join('\n');
    const cases = testCases(ok({ testResult: { ok: false, passed: 2, failed: 1, output } }));
    expect(cases.map((c) => [c.name, c.ok])).toEqual([
      ['blocks a post with 6 links', true],
      ['lets a normal post through', false],
      ['ignores old accounts', true],
    ]);
    expect(cases[1]?.detail).toContain('Received: "reject"');
    expect(cases[0]?.detail).toBeUndefined();
  });

  it('prefers the server’s test cases, steps and permissions when sent', () => {
    const o = ok({
      testCases: [
        { name: 'blocks spam', ok: true },
        { name: 'lets hello through', ok: false, error: 'Expected accept' },
      ],
      steps: ['writing', 'checking', 'testing', 'installing'],
      permissions: ['docs', 'network'],
    });
    expect(testCases(o)).toEqual([
      { name: 'blocks spam', ok: true },
      { name: 'lets hello through', ok: false, detail: 'Expected accept' },
    ]);
    expect(testCounts({ ...o, testResult: { ok: false } })).toEqual({ passed: 1, failed: 1 });
    expect(stepsLine(o)).toBe('steps: writing → checking → testing → installing');
    expect(stepsLine(ok())).toBe('');
    expect(declaredPermissions(o)).toEqual(['network', 'docs']);
    expect(needsApproval(o)).toBe(true);
    expect(needsApproval({ ...o, installed: false })).toBe(false);
    expect(needsApproval(ok({ code: 'definePlugin({})' }))).toBe(false);
  });
});

describe('written by the assistant marker', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it('remembers ids and recognises server-side origin', () => {
    const kv = mem();
    markAi('ai-links', true, kv);
    expect(aiMarked(kv).has('ai-links')).toBe(true);
    markAi('ai-links', false, kv);
    expect(aiMarked(kv).size).toBe(0);
    expect(writtenByAssistant('x', { source: 'ai' }, new Set())).toBe(true);
    expect(writtenByAssistant('x', undefined, new Set(['x']))).toBe(true);
    expect(writtenByAssistant('x', {}, new Set())).toBe(false);
  });

  it('survives broken storage', () => {
    const kv = { getItem: () => '{nope', setItem: () => {} };
    expect(aiMarked(kv).size).toBe(0);
    expect(aiMarked(null).size).toBe(0);
  });
});

describe('deferred discard', () => {
  it('removes after the undo window, unless undone; flush removes at once', () => {
    vi.useFakeTimers();
    const removed: string[] = [];
    const d = new DeferredDiscard((id) => void removed.push(id), 8000);
    d.schedule('a');
    d.schedule('b');
    expect(d.cancel('b')).toBe(true);
    vi.advanceTimersByTime(7999);
    expect(removed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(removed).toEqual(['a']);
    expect(d.cancel('a')).toBe(false);
    d.schedule('c');
    d.flush();
    expect(removed).toEqual(['a', 'c']);
    vi.advanceTimersByTime(10_000);
    expect(removed).toEqual(['a', 'c']);
    vi.useRealTimers();
  });
});
