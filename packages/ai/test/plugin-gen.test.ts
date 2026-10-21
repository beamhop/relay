// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  FakeLLM,
  type GeneratePluginOutput,
  type GeneratedPlugin,
  type PluginHostLike,
  checkGenerated,
  describePlugin,
  extractCode,
  parseTestCases,
} from '../src/index.ts';
import { P, boot } from './helpers.ts';

const PLUGIN = `import { definePlugin } from '@beamhop/plugins/sdk';

export default definePlugin({
  id: 'ai-block-casino',
  name: 'Block casino spam',
  description: 'Rejects posts that advertise casinos',
  priority: 300,
  onEvent(event) {
    if (/casino/i.test(event.content)) return { action: 'reject', prefix: 'blocked', message: 'Casino ads are not allowed here' };
    return { action: 'accept' };
  },
});`;

const TESTS = `import { describe, expect, test } from 'bun:test';
import { createTestbed } from '@beamhop/plugins/testbed';
import plugin from './plugin.ts';

describe('ai-block-casino', () => {
  test('blocks casino ads', async () => {
    const bed = createTestbed(plugin);
    expect((await bed.event({ kind: 1, content: 'best CASINO bonus' })).action).toBe('reject');
  });
  test('lets normal posts through', async () => {
    const bed = createTestbed(plugin);
    expect((await bed.event({ kind: 1, content: 'hello' })).action).toBe('accept');
  });
});`;

const reply = (code = PLUGIN, tests = TESTS) =>
  `Here you go:\n\n\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`ts\n${tests}\n\`\`\`\n`;

function mockHost(results: boolean[]) {
  const calls = {
    test: [] as GeneratedPlugin[],
    install: [] as unknown[],
    uninstall: [] as string[],
  };
  const host: PluginHostLike = {
    async test(p) {
      calls.test.push(p);
      const ok = results.shift() ?? false;
      return ok
        ? { ok, passed: 2, failed: 0 }
        : { ok, passed: 1, failed: 1, output: 'expected reject, got accept' };
    },
    async install(p) {
      calls.install.push(p);
      return { id: p.id };
    },
    async uninstall(id) {
      calls.uninstall.push(id);
    },
  };
  return { host, calls };
}

async function run(llm: FakeLLM, host: PluginHostLike | undefined) {
  const b = await boot({ llm, ai: { loadPluginHost: async () => host } });
  const def = b.kernel.actions.get('ai.generate-plugin')!;
  const ctx = { principal: P.owner, relayId: null, ports: b.kernel.ports };
  const input = def.input.parse({
    description: 'Block posts that advertise online casinos',
    id: 'block-casino',
  });
  const r = await def.run(input, ctx);
  return { ...b, def, ctx, r, out: r.output as GeneratePluginOutput };
}

describe('ai.generate-plugin', () => {
  test('is a sensitive plugins.write action with a preview', async () => {
    const { kernel } = await boot();
    const def = kernel.actions.get('ai.generate-plugin')!;
    expect(def.sensitive).toBe(true);
    expect(def.permission).toBe('plugins.write');
    expect(def.readOnly).toBeFalsy();
    const diff = await def.preview!(
      { description: 'Block casino spam please' },
      { principal: P.owner, relayId: null, ports: kernel.ports },
    );
    expect(diff.map((d) => d.text).join(' ')).toContain('turned OFF');
  });

  test('tests pass in the sandbox → installed DISABLED, undo uninstalls', async () => {
    const { host, calls } = mockHost([true]);
    const llm = new FakeLLM([reply()]);
    const { out, r, def, ctx, kernel } = await run(llm, host);
    expect(out.id).toBe('ai-block-casino');
    expect(out.tested).toBe(true);
    expect(out.installed).toBe(true);
    expect(out.enabled).toBe(false);
    expect(out.code).toContain('definePlugin');
    expect(out.tests).toContain('createTestbed');
    expect(calls.test).toHaveLength(1);
    expect(calls.install).toEqual([
      expect.objectContaining({ id: 'ai-block-casino', enabled: false, source: 'ai' }),
    ]);
    expect(await kernel.ports.docs.get('ai.plugins', 'ai-block-casino')).toMatchObject({
      enabled: false,
    });
    // The description was fenced as untrusted data.
    expect(llm.calls[0]!.messages[1]!.content).toMatch(
      /<untrusted-[0-9a-f]+ source="admin-description">/,
    );
    expect(r.undo?.payload).toEqual({ id: 'ai-block-casino' });
    await def.undo!(r.undo!.payload, ctx);
    expect(calls.uninstall).toEqual(['ai-block-casino']);
  });

  test('failing tests → one repair round → still failing → not installed', async () => {
    const { host, calls } = mockHost([false, false]);
    const llm = new FakeLLM([reply(), reply()]);
    const { out } = await run(llm, host);
    expect(calls.test).toHaveLength(2);
    expect(calls.install).toHaveLength(0);
    expect(out.installed).toBe(false);
    expect(out.testResult?.ok).toBe(false);
    // The repair prompt carried the (fenced) test output.
    expect(llm.calls[1]!.messages[1]!.content).toContain('expected reject, got accept');
  });

  test('repair round can fix it', async () => {
    const { host, calls } = mockHost([false, true]);
    const { out } = await run(new FakeLLM([reply(), reply()]), host);
    expect(out.installed).toBe(true);
    expect(calls.install).toHaveLength(1);
  });

  test('no plugin host → code only', async () => {
    const { out, r } = await run(new FakeLLM([reply()]), undefined);
    expect(out.tested).toBe(false);
    expect(out.installed).toBe(false);
    expect(out.code).toContain('definePlugin');
    expect(r.undo).toBeUndefined();
  });

  test('unsafe code is rejected before reaching the sandbox', async () => {
    const evil = PLUGIN.replace(
      "import { definePlugin } from '@beamhop/plugins/sdk';",
      "import { definePlugin } from '@beamhop/plugins/sdk';\nimport fs from 'node:fs';",
    ).replace(
      "return { action: 'accept' };",
      "fetch('https://evil.example'); return { action: 'accept' };",
    );
    const { host, calls } = mockHost([true]);
    const { out } = await run(new FakeLLM([reply(evil), reply(evil)]), host);
    expect(calls.test).toHaveLength(0);
    expect(out.installed).toBe(false);
    expect(out.problems.join(' ')).toContain('node:fs');
  });

  test('helpers: extractCode and checkGenerated', () => {
    expect(extractCode('no code here')).toBeNull();
    const got = extractCode(reply())!;
    expect(got.code).toContain('definePlugin');
    expect(got.tests).toContain("from 'bun:test'");
    expect(checkGenerated({ id: 'x', ...got })).toEqual([]);
    expect(checkGenerated({ id: 'x', code: 'export default 1', tests: '' }).length).toBeGreaterThan(
      1,
    );
  });
});

describe('ai.generate-plugin: review fields', () => {
  const BUN_OUTPUT = [
    'bun test v1.2.0',
    '',
    'plugin.test.ts:',
    '(pass) ai-block-casino > blocks casino ads [0.21ms]',
    'error: expect(received).toBe(expected)',
    'Expected: "accept"',
    'Received: "reject"',
    '      at <anonymous> (./plugin.test.ts:12:5)',
    '(fail) ai-block-casino > lets normal posts through [0.10ms]',
    '',
    ' 1 pass',
    ' 1 fail',
  ].join('\n');

  test('name, summary, permissions, test cases and steps after an install', async () => {
    const withPerms = PLUGIN.replace(
      'priority: 300,',
      "priority: 300,\n  permissions: ['read-events', 'network', 'bogus'],",
    );
    const host: PluginHostLike = {
      test: async () => ({
        ok: true,
        passed: 2,
        failed: 0,
        output: '(pass) s > blocks casino ads [1ms]\n(pass) s > lets normal posts through [1ms]',
      }),
      install: async (p) => ({ id: p.id }),
    };
    const { out } = await run(new FakeLLM([reply(withPerms)]), host);
    expect(out.name).toBe('Block casino spam');
    expect(out.summary).toBe('Rejects posts that advertise casinos.');
    expect(out.permissions).toEqual(['read-events', 'network']);
    expect(out.testCases).toEqual([
      { name: 'blocks casino ads', ok: true },
      { name: 'lets normal posts through', ok: true },
    ]);
    expect(out.steps).toEqual(['writing', 'checking', 'testing', 'installing']);
    expect(out.note).toContain('allow its access');
  });

  test('failed tests: failing case carries the error; steps stop before testing', async () => {
    const host: PluginHostLike = {
      test: async () => ({ ok: false, passed: 1, failed: 1, output: BUN_OUTPUT }),
      install: async (p) => ({ id: p.id }),
    };
    const { out } = await run(new FakeLLM([reply(), reply()]), host);
    expect(out.installed).toBe(false);
    expect(out.permissions).toEqual([]);
    expect(out.steps).toEqual(['writing', 'checking']);
    expect(out.testCases?.[0]).toEqual({ name: 'blocks casino ads', ok: true });
    expect(out.testCases?.[1]?.ok).toBe(false);
    expect(out.testCases?.[1]?.error).toContain('Expected: "accept"');
  });

  test('helpers: describePlugin and parseTestCases', () => {
    expect(describePlugin("definePlugin({ id: 'x' })", 'Hold nsfw posts for review')).toEqual({
      summary: 'Hold nsfw posts for review.',
      permissions: [],
    });
    expect(
      describePlugin(
        `definePlugin({ name: "Night mode", description: 'Slows posters. Second sentence.', permissions: ["docs"] })`,
      ),
    ).toEqual({ name: 'Night mode', summary: 'Slows posters.', permissions: ['docs'] });
    expect(parseTestCases('no test names here')).toEqual([]);
    expect(parseTestCases('✓ works\n✗ breaks')).toEqual([
      { name: 'works', ok: true },
      { name: 'breaks', ok: false },
    ]);
  });
});
