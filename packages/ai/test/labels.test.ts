// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type PolicyService, createPolicyModule } from '@beamhop/policy';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { type AiService, FakeLLM, parseLabel } from '../src/index.ts';
import { P, boot } from './helpers.ts';

async function setup(llm: FakeLLM, aiConfig: Record<string, unknown> = {}) {
  const b = await boot({ llm, extra: [createPolicyModule()], aiConfig });
  const policy = b.kernel.use<PolicyService>('policy')!;
  const key = makeKey();
  const hold = async (content: string) => {
    const event = makeEvent(key, { content });
    b.kernel.bus.emit('event.held', {
      relayId: 'main',
      event,
      by: 'test',
      reason: 'Looks unusual',
    });
    await policy.idle();
    return event;
  };
  return { ...b, policy, hold, ai: b.kernel.use<AiService>('ai')! };
}

describe('parseLabel (strict JSON)', () => {
  test('accepts clean, fenced and synonym answers', () => {
    expect(parseLabel('{"label":"spam","reason":"Crypto giveaway link"}')).toEqual({
      label: 'spam',
      reason: 'Crypto giveaway link',
    });
    expect(parseLabel('```json\n{"label":"Abusive","reason":"Insults a user"}\n```')?.label).toBe(
      'abuse',
    );
    expect(parseLabel('Sure! {"label":"fine","reason":"A normal post"}')?.label).toBe('ok');
  });

  test('rejects malformed output', () => {
    expect(parseLabel('')).toBeNull();
    expect(parseLabel('spam')).toBeNull();
    expect(parseLabel('{"label":"spam"}')).toBeNull();
    expect(parseLabel('{"label":"delete-it","reason":"x"}')).toBeNull();
    expect(parseLabel('{label: spam, reason: oops}')).toBeNull();
    expect(parseLabel('{"label":"spam","reason":"   "}')).toBeNull();
  });

  test('reason is one short line without IPs', () => {
    const r = parseLabel(
      JSON.stringify({ label: 'spam', reason: `posted from 10.2.3.4\n${'very '.repeat(60)}long` }),
    )!;
    expect(r.reason).not.toContain('\n');
    expect(r.reason).not.toContain('10.2.3.4');
    expect(r.reason.length).toBeLessThanOrEqual(160);
  });
});

describe('moderation pre-labels', () => {
  test('labels pending queue items, stores them in ai.labels, never acts', async () => {
    const llm = new FakeLLM([], '{"label":"spam","reason":"Repeated giveaway link"}');
    const { kernel, policy, hold, ai } = await setup(llm);
    const event = await hold('FREE BITCOIN click here https://scam.example');
    const stats = await ai.labels.runOnce();
    expect(stats.labeled).toBe(1);
    const labels = await ai.labels.list('main');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      relayId: 'main',
      itemId: `held-${event.id}`,
      status: 'labeled',
      label: 'spam',
      reason: 'Repeated giveaway link',
      model: 'fake',
    });
    // Queue item untouched (still pending), nothing removed.
    const items = await policy.queue.list('main');
    expect(items.map((i) => i.status)).toEqual(['pending']);
    expect(await kernel.ports.events.getById('main', event.id)).toBeNull();
    // Event content was fenced as untrusted in the prompt.
    const prompt = llm.calls[0]!.messages[1]!.content;
    expect(prompt).toMatch(/<untrusted-[0-9a-f]+ source="queue-item">/);
    expect(prompt).toContain('FREE BITCOIN');
    // Already labeled → not asked again.
    await ai.labels.runOnce();
    expect(llm.calls).toHaveLength(1);
    // Exposed as a read-only action for the swipe cards.
    const r = await kernel.actions
      .get('ai.moderation-labels')!
      .run(
        { ids: [`held-${event.id}`] },
        { principal: P.viewer, relayId: 'main', ports: kernel.ports },
      );
    expect((r.output as { labels: unknown[] }).labels).toHaveLength(1);
  });

  test('malformed output is retried, then given up', async () => {
    const llm = new FakeLLM(['not json at all', 'still {broken'], 'never reached');
    const { hold, ai } = await setup(llm, { labeling: { maxAttempts: 2 } });
    await hold('hello');
    expect((await ai.labels.runOnce()).failed).toBe(1);
    expect((await ai.labels.list('main'))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await ai.labels.runOnce()).failed).toBe(1);
    expect((await ai.labels.list('main'))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    const third = await ai.labels.runOnce();
    expect(third).toEqual({ labeled: 0, failed: 0, skipped: 1 });
    expect(llm.calls).toHaveLength(2);
  });

  test('model errors are recorded, not thrown', async () => {
    const llm = new FakeLLM([
      () => {
        throw new Error('model offline');
      },
    ]);
    const { hold, ai } = await setup(llm);
    await hold('hello');
    expect(await ai.labels.runOnce()).toEqual({ labeled: 0, failed: 1, skipped: 0 });
  });

  test('rate-limited per run and per hour', async () => {
    const llm = new FakeLLM([], '{"label":"ok","reason":"Normal"}');
    const { hold, ai, ports } = await setup(llm, { labeling: { perRun: 2, perHour: 3 } });
    for (let i = 0; i < 5; i++) await hold(`post ${i}`);
    expect((await ai.labels.runOnce()).labeled).toBe(2);
    expect((await ai.labels.runOnce()).labeled).toBe(1);
    expect((await ai.labels.runOnce()).labeled).toBe(0);
    ports.clock.advance(3601);
    expect((await ai.labels.runOnce()).labeled).toBe(2);
  });

  test('skipped when labeling or AI is turned off; runs from the scheduler', async () => {
    const llm = new FakeLLM([], '{"label":"ok","reason":"Normal"}');
    const off = await setup(llm, { labeling: { enabled: false } });
    await off.hold('x');
    expect(await off.ai.labels.runOnce()).toEqual({ labeled: 0, failed: 0, skipped: 0 });

    const on = await setup(llm);
    await on.hold('y');
    await on.ports.scheduler.tick('ai.label-queue');
    expect(await on.ai.labels.list('main')).toHaveLength(1);
    await on.kernel.applyConfig({
      ...on.kernel.config(),
      ai: { ...on.kernel.config().ai, enabled: false },
    });
    await on.hold('z');
    expect(await on.ai.labels.runOnce()).toEqual({ labeled: 0, failed: 0, skipped: 0 });
  });
});
