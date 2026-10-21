// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `ai.generate-plugin` (§6.5.4): turn a plain description into a TypeScript
 * policy plugin (`definePlugin` from `@beamhop/plugins/sdk`) plus tests for the
 * plugin testbed, run the tests in the plugin host's sandbox and install the
 * plugin DISABLED for admin review. Without a plugin host, only the code is
 * returned. Never enables anything.
 */
import { type ActionDef, type Kernel, defineAction } from '@beamhop/core';
import { z } from 'zod';
import { type AiModuleConfig, COL } from './config.ts';
import type { AiLLM } from './llm.ts';
import { UNTRUSTED_RULES, scrubText, truncate, untrusted, withTimeout } from './safety.ts';

export interface GeneratedPlugin {
  id: string;
  code: string;
  tests: string;
}

export interface PluginTestResult {
  ok: boolean;
  passed?: number;
  failed?: number;
  output?: string;
}

/**
 * Duck-typed plugin host (from `kernel.use('plugins')` or the `@beamhop/plugins`
 * package). Every method is optional; missing ones degrade gracefully.
 */
export interface PluginHostLike {
  /** Extra SDK guidance appended to the generation prompt. */
  sdkGuide?: string;
  /** Run `tests` against `code` in the sandbox. */
  test?(p: GeneratedPlugin): Promise<PluginTestResult>;
  /** Install the plugin; the AI always passes `enabled: false`. */
  install?(
    p: GeneratedPlugin & { enabled: false; source: 'ai'; description: string },
  ): Promise<unknown>;
  uninstall?(id: string): Promise<void>;
}

export type PluginHostLoader = (kernel: Kernel) => Promise<PluginHostLike | undefined>;

const isHost = (v: unknown): v is PluginHostLike =>
  !!v &&
  typeof v === 'object' &&
  (typeof (v as PluginHostLike).test === 'function' ||
    typeof (v as PluginHostLike).install === 'function');

/** Default loader: the `plugins` service, else a dynamic import of `@beamhop/plugins`. */
export const defaultPluginHostLoader: PluginHostLoader = async (kernel) => {
  const svc = kernel.use<unknown>('plugins');
  if (isHost(svc)) return svc;
  const host = (svc as { host?: unknown } | undefined)?.host;
  if (isHost(host)) return host;
  try {
    const spec = '@beamhop/plugins';
    const mod = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
    for (const name of ['pluginHost', 'host', 'aiPluginHost'])
      if (isHost(mod[name])) return mod[name];
    const factory = mod.createPluginHost ?? mod.createAiPluginHost;
    if (typeof factory === 'function') {
      const made = await (factory as (k: Kernel) => unknown)(kernel);
      if (isHost(made)) return made;
    }
  } catch {
    // plugin system not installed → code only
  }
  return undefined;
};

export const SDK_GUIDE = `Plugin file (plugin.ts) shape:
\`\`\`ts
import { definePlugin } from '@beamhop/plugins/sdk';

export default definePlugin({
  id: '<plugin id>',
  name: 'Plain-language name',
  description: 'One sentence: what it does',
  priority: 300, // plugins run at 300+
  // Hooks (all optional): onConnect(ctx), onAuth(pubkey, ctx), onEvent(event, ctx),
  // onReq(filters, ctx), onUpload(info, ctx), onBlobServe(sha256, ctx).
  // Return a decision: { action: 'accept' } | { action: 'reject', prefix: 'blocked', message: '...' }
  //   | { action: 'hold', message?: '...' } | { action: 'shadow' }.
  onEvent(event, ctx) {
    return { action: 'accept' };
  },
});
\`\`\`
Test file (plugin.test.ts) shape:
\`\`\`ts
import { describe, expect, test } from 'bun:test';
import { createTestbed } from '@beamhop/plugins/testbed';
import plugin from './plugin.ts';

describe('<plugin id>', () => {
  test('rejects …', async () => {
    const bed = createTestbed(plugin);
    const decision = await bed.event({ kind: 1, content: '…' });
    expect(decision.action).toBe('reject');
  });
});
\`\`\``;

const ALLOWED_CODE_IMPORTS = new Set(['@beamhop/plugins/sdk']);
const ALLOWED_TEST_IMPORTS = new Set([
  'bun:test',
  '@beamhop/plugins/sdk',
  '@beamhop/plugins/testbed',
  './plugin',
  './plugin.ts',
]);
const FORBIDDEN = [
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /\bprocess\./,
  /\bBun\./,
  /\bDeno\./,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bglobalThis\b/,
  /\bchild_process\b/,
];

/** Static checks before anything reaches the sandbox: imports allow-listed, no escape hatches. */
export function checkGenerated(p: GeneratedPlugin): string[] {
  const problems: string[] = [];
  const imports = (src: string) =>
    [
      ...src.matchAll(/^\s*import\s[\s\S]*?from\s*['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ].map((m) => m[1] as string);
  for (const i of imports(p.code))
    if (!ALLOWED_CODE_IMPORTS.has(i))
      problems.push(`plugin imports a module that is not allowed: ${i}`);
  for (const i of imports(p.tests))
    if (!ALLOWED_TEST_IMPORTS.has(i))
      problems.push(`tests import a module that is not allowed: ${i}`);
  for (const re of FORBIDDEN) {
    if (re.test(p.code)) problems.push(`plugin uses a forbidden feature (${re.source})`);
    if (re.test(p.tests)) problems.push(`tests use a forbidden feature (${re.source})`);
  }
  if (!/\bdefinePlugin\s*\(/.test(p.code)) problems.push('plugin does not call definePlugin()');
  if (!/\bexport\s+default\b/.test(p.code)) problems.push('plugin has no default export');
  if (!/\b(test|it)\s*\(/.test(p.tests)) problems.push('tests contain no test cases');
  if (p.code.length > 20_000 || p.tests.length > 20_000)
    problems.push('generated code is too long');
  return problems;
}

/** Extract plugin + tests from a model reply (two fenced code blocks). */
export function extractCode(text: string): { code: string; tests: string } | null {
  const blocks = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
  if (blocks.length < 2) return null;
  const tests = blocks.find((b) => /from\s+['"]bun:test['"]/.test(b)) ?? blocks[1]!;
  const code =
    blocks.find((b) => b !== tests && /definePlugin/.test(b)) ?? blocks.find((b) => b !== tests)!;
  return { code, tests };
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'plugin';
}

const SYSTEM = [
  'You write small, safe TypeScript policy plugins for the Beamhop Nostr relay.',
  'Reply with exactly two fenced ```ts code blocks: first plugin.ts, then plugin.test.ts. No other text is needed.',
  'Rules: only import from "@beamhop/plugins/sdk" in the plugin; tests may import "bun:test", "@beamhop/plugins/testbed" and "./plugin.ts".',
  'No network, files, timers, eval, dynamic imports or globals. Keep it short and readable, with plain-language reject messages.',
  'Write at least 3 tests: one that should be blocked, one that should pass, and one edge case.',
  UNTRUSTED_RULES,
].join('\n');

export interface GeneratePluginDeps {
  kernel: Kernel;
  llm: () => AiLLM | undefined;
  settings: () => AiModuleConfig;
  loadHost: PluginHostLoader;
}

export const GeneratePluginInput = z.object({
  description: z
    .string()
    .trim()
    .min(10)
    .max(2000)
    .describe('What the plugin should do, in your own words'),
  id: z
    .string()
    .regex(/^[a-z0-9-]{3,48}$/)
    .optional()
    .describe('Short id (letters, digits, dashes); made up from the description when empty'),
});

export interface GeneratePluginOutput {
  id: string;
  code: string;
  tests: string;
  tested: boolean;
  testResult?: PluginTestResult;
  installed: boolean;
  enabled: false;
  problems: string[];
  note: string;
  /** Plain name declared in `definePlugin({ name })`. */
  name?: string;
  /** One plain sentence: what the plugin does (its `description`, else the admin's words). */
  summary?: string;
  /** Permissions the code declares. They stay OFF until an admin approves them. */
  permissions?: PluginPermissionName[];
  /** Test cases from the sandbox run (`tests` is the test file itself). */
  testCases?: PluginTestCase[];
  /** Phases that completed, in order. */
  steps?: PluginGenStep[];
}

export const PLUGIN_PERMISSIONS = ['read-events', 'write-events', 'network', 'docs'] as const;
export type PluginPermissionName = (typeof PLUGIN_PERMISSIONS)[number];
export type PluginGenStep = 'writing' | 'checking' | 'testing' | 'installing';
export interface PluginTestCase {
  name: string;
  ok: boolean;
  error?: string;
}

const stringField = (src: string, key: string): string | undefined => {
  const m = src.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
  return m?.[2]?.replace(/\\(['"`\\])/g, '$1');
};

/** Name, one-sentence summary and declared permissions read from the plugin code. */
export function describePlugin(
  code: string,
  fallbackSummary = '',
): { name?: string; summary?: string; permissions: PluginPermissionName[] } {
  const out: { name?: string; summary?: string; permissions: PluginPermissionName[] } = {
    permissions: [],
  };
  const name = stringField(code, 'name')?.trim();
  if (name) out.name = truncate(name, 80);
  const summary = (stringField(code, 'description') ?? fallbackSummary).trim();
  if (summary) {
    const first = summary.split(/(?<=[.!?])\s/)[0]?.trim() ?? summary;
    out.summary = truncate(/[.!?]$/.test(first) ? first : `${first}.`, 200);
  }
  const list = code.match(/\bpermissions\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';
  const raw = new Set([...list.matchAll(/['"`]([a-z-]+)['"`]/g)].map((m) => m[1]));
  out.permissions = PLUGIN_PERMISSIONS.filter((p) => raw.has(p));
  return out;
}

const RESULT_LINE = /^\s*(\(pass\)|\(fail\)|✓|✔|✗|✘|×)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/;

/**
 * Test cases from the test runner output (`(pass) suite > name [1ms]`,
 * `(fail) …` with the error printed just before it). Empty when the output
 * names no tests.
 */
export function parseTestCases(output: string): PluginTestCase[] {
  const cases: PluginTestCase[] = [];
  let pending: string[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(RESULT_LINE);
    if (!m) {
      if (line.trim()) pending.push(line.trimEnd());
      continue;
    }
    const ok = m[1] === '(pass)' || m[1] === '✓' || m[1] === '✔';
    const full = m[2] ?? '';
    const c: PluginTestCase = { name: full.split(' > ').pop() ?? full, ok };
    if (!ok) {
      const err = pending
        .filter((l) => !/^\s*\d+\s*\|/.test(l))
        .join('\n')
        .trim();
      if (err) c.error = truncate(err, 1000);
    }
    cases.push(c);
    pending = [];
  }
  return cases.slice(0, 100);
}

export function generatePluginAction(deps: GeneratePluginDeps): ActionDef {
  return defineAction({
    id: 'ai.generate-plugin',
    title: 'Write a plugin with AI',
    description:
      'Describe a rule in your own words. The assistant writes a plugin and tests, checks them, and installs it turned off so you can review it first.',
    technical:
      'LLM → plugin.ts (definePlugin, @beamhop/plugins/sdk) + plugin.test.ts (testbed); static import allow-list; tests run in the plugin host sandbox; installed with enabled=false.',
    scope: 'node',
    permission: 'plugins.write',
    sensitive: true,
    keywords: ['plugin', 'ai', 'rule', 'filter', 'generate'],
    input: GeneratePluginInput,
    async preview(input) {
      const id = `ai-${input.id ?? slugify(input.description)}`;
      return [
        {
          kind: 'add',
          text: `A new plugin “${id}” will be written from your description`,
          technical: `plugins/${id}`,
        },
        {
          kind: 'info',
          text: 'Its tests run in a sandbox first; if they fail, nothing is installed',
        },
        {
          kind: 'info',
          text: 'It is installed turned OFF — it does nothing until you review and turn it on',
        },
      ];
    },
    async run(
      input,
      ctx,
    ): Promise<{
      output: GeneratePluginOutput;
      summary: string;
      undo?: { actionId: string; payload: unknown; expiresAt: number };
    }> {
      const llm = deps.llm();
      if (!llm || !deps.kernel.config().ai.enabled)
        throw new Error('The assistant is turned off. Turn it on in Settings → AI.');
      const settings = deps.settings();
      const id = `ai-${input.id ?? slugify(input.description)}`;
      const host = await deps.loadHost(deps.kernel).catch(() => undefined);
      const guide = host?.sdkGuide ? `${SDK_GUIDE}\n\nHost notes:\n${host.sdkGuide}` : SDK_GUIDE;

      const ask = async (extra: string): Promise<GeneratedPlugin | null> => {
        const controller = new AbortController();
        const reply = await withTimeout(
          llm.chat(
            [
              { role: 'system', content: `${SYSTEM}\n\n${guide}` },
              {
                role: 'user',
                content: `Plugin id: ${id}\nWhat the admin wants (their words):\n${untrusted('admin-description', truncate(input.description, 2000))}${extra}`,
              },
            ],
            { signal: controller.signal, maxOutputTokens: 3000, temperature: 0.1 },
          ),
          settings.timeoutSeconds * 1000,
          () => controller.abort(),
        );
        const got = extractCode(reply.content);
        return got ? { id, ...got } : null;
      };

      let plugin: GeneratedPlugin | null = null;
      let problems: string[] = [];
      let testResult: PluginTestResult | undefined;
      let extra = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        plugin = await ask(extra);
        if (!plugin) {
          problems = ['The model did not return a plugin and tests'];
          extra =
            '\n\nYour last reply did not contain two ```ts code blocks. Reply with exactly two blocks.';
          continue;
        }
        problems = checkGenerated(plugin);
        if (problems.length) {
          extra = `\n\nYour last attempt had problems:\n- ${problems.join('\n- ')}\nFix them.`;
          continue;
        }
        if (!host?.test) break;
        testResult = await withTimeout(host.test(plugin), 120_000).catch((err) => ({
          ok: false,
          output: `The test run failed: ${String(err)}`,
        }));
        if (testResult.ok) break;
        extra = `\n\nThe tests failed. Output:\n${untrusted('test-output', truncate(scrubText(testResult.output ?? ''), 3000))}\nFix the plugin or the tests.`;
      }

      const info = plugin ? describePlugin(plugin.code, input.description) : null;
      const testCases = testResult?.output ? parseTestCases(testResult.output) : [];
      const steps: PluginGenStep[] = plugin ? ['writing'] : [];
      if (plugin && !problems.length) steps.push('checking');
      if (testResult?.ok) steps.push('testing');
      const base = {
        id,
        code: plugin?.code ?? '',
        tests: plugin?.tests ?? '',
        enabled: false as const,
        problems,
        ...(info?.name ? { name: info.name } : {}),
        ...(info?.summary ? { summary: info.summary } : {}),
        ...(info ? { permissions: info.permissions } : {}),
        ...(testCases.length ? { testCases } : {}),
        steps,
      };
      if (!plugin || problems.length) {
        return {
          output: {
            ...base,
            tested: false,
            installed: false,
            note: 'The plugin could not be written safely. Try describing it differently.',
          },
          summary: `Could not write plugin “${id}”`,
        };
      }
      if (!host?.test) {
        return {
          output: {
            ...base,
            tested: false,
            installed: false,
            note: 'The plugin system is not available here, so the code was not tested or installed. Review it and add it by hand.',
          },
          summary: `Wrote plugin draft “${id}” (not tested)`,
        };
      }
      if (!testResult?.ok) {
        return {
          output: {
            ...base,
            tested: true,
            testResult,
            installed: false,
            note: 'The tests did not pass, so the plugin was not installed.',
          },
          summary: `Wrote plugin “${id}”, but its tests failed — not installed`,
        };
      }
      let installed = false;
      if (host.install) {
        await host.install({
          ...plugin,
          enabled: false,
          source: 'ai',
          description: input.description,
        });
        installed = true;
        await ctx.ports.docs.put(COL.plugins, id, {
          id,
          description: input.description,
          by: ctx.principal.id,
          at: ctx.ports.clock.now(),
          enabled: false,
        });
      }
      if (installed) steps.push('installing');
      const out: GeneratePluginOutput = {
        ...base,
        tested: true,
        testResult,
        installed,
        note: installed
          ? info?.permissions.length
            ? 'Installed turned OFF, with the access it asks for switched off. Review it, allow its access if you agree, then turn it on.'
            : 'Installed turned OFF. Review the code, then turn it on in Settings → Plugins.'
          : 'Tests passed, but this plugin system cannot install plugins; add it by hand.',
      };
      const result: {
        output: GeneratePluginOutput;
        summary: string;
        undo?: { actionId: string; payload: unknown; expiresAt: number };
      } = {
        output: out,
        summary: installed
          ? `Wrote and installed plugin “${id}” (turned off)`
          : `Wrote and tested plugin “${id}”`,
      };
      if (installed && host.uninstall)
        result.undo = {
          actionId: 'ai.generate-plugin',
          payload: { id },
          expiresAt: ctx.ports.clock.now() + 300,
        };
      return result;
    },
    async undo(payload, ctx) {
      const { id } = payload as { id: string };
      const host = await deps.loadHost(deps.kernel);
      await host?.uninstall?.(id);
      await ctx.ports.docs.delete(COL.plugins, id);
    },
  }) as unknown as ActionDef;
}
