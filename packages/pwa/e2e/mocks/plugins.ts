// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mock of `ai.generate-plugin` (packages/ai/src/plugin-gen.ts) for the plugin
 * writer E2E specs. Descriptions decide the outcome:
 *   - contains "fail"   → tests ran and one failed; nothing installed
 *   - contains "broken" → the model returned nothing usable
 *   - anything else     → tests pass; installed TURNED OFF (undo removes it)
 */
import { z } from 'zod';

type Diff = { kind: 'add' | 'remove' | 'change' | 'info' | 'warning'; text: string };

export interface MockAction {
  id: string;
  title: string;
  description: string;
  scope: 'node' | 'relay';
  permission: string;
  input: z.ZodType;
  preview?: (input: Record<string, unknown>) => Diff[];
  run: (input: Record<string, unknown>) => { output: unknown; summary: string; undo?: () => void };
}

export interface PluginMockDeps {
  /** Install / patch a plugin in the mock state; returns its undo. */
  setPlugin: (id: string, patch: { enabled: boolean }) => () => void;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'plugin';

const code = (
  id: string,
  description: string,
) => `import { definePlugin } from '@beamhop/plugins/sdk';

export default definePlugin({
  id: '${id}',
  name: 'Limit links from newcomers',
  description: ${JSON.stringify(description)},
  permissions: ['read-events'],
  priority: 300,
  onEvent(event, ctx) {
    const links = (event.content.match(/https?:\\/\\//g) ?? []).length;
    if (links > 5) return { action: 'reject', prefix: 'blocked', message: 'too many links' };
    return { action: 'accept' };
  },
});
`;

const tests = (id: string) => `import { describe, expect, test } from 'bun:test';
import { createTestbed } from '@beamhop/plugins/testbed';
import plugin from './plugin.ts';

describe('${id}', () => {
  test('blocks a post with 6 links', async () => {
    expect((await createTestbed(plugin).event({ kind: 1, content: 'https:// '.repeat(6) })).action).toBe('reject');
  });
  test('lets a normal post through', async () => {
    expect((await createTestbed(plugin).event({ kind: 1, content: 'hi' })).action).toBe('accept');
  });
  test('ignores old accounts', async () => {});
});
`;

export function pluginWriterActions(deps: PluginMockDeps): MockAction[] {
  return [
    {
      id: 'ai.generate-plugin',
      title: 'Write a plugin with AI',
      description: 'Describe a rule in your own words.',
      scope: 'node',
      permission: 'plugins.write',
      input: z.object({
        description: z.string().trim().min(10).max(2000),
        id: z
          .string()
          .regex(/^[a-z0-9-]{3,48}$/)
          .optional(),
      }),
      preview: (i) => [
        { kind: 'add', text: `A new plugin “ai-${slug(String(i.description))}” will be written` },
      ],
      run: (i) => {
        const description = String(i.description);
        const id = `ai-${(i.id as string | undefined) ?? slug(description)}`;
        const base = {
          id,
          code: code(id, description),
          tests: tests(id),
          enabled: false,
          problems: [] as string[],
        };
        if (/broken/i.test(description))
          return {
            output: {
              ...base,
              code: '',
              tests: '',
              problems: ['The model did not return a plugin and tests'],
              tested: false,
              installed: false,
              note: 'The plugin could not be written safely. Try describing it differently.',
            },
            summary: `Could not write plugin “${id}”`,
          };
        if (/fail/i.test(description))
          return {
            output: {
              ...base,
              tested: true,
              installed: false,
              testResult: {
                ok: false,
                passed: 2,
                failed: 1,
                output: [
                  `(pass) ${id} > blocks a post with 6 links [0.20ms]`,
                  'error: expect(received).toBe(expected)',
                  'Expected: "accept"',
                  'Received: "reject"',
                  `(fail) ${id} > lets a normal post through [0.31ms]`,
                  `(pass) ${id} > ignores old accounts [0.02ms]`,
                ].join('\n'),
              },
              note: 'The tests did not pass, so the plugin was not installed.',
            },
            summary: `Wrote plugin “${id}”, but its tests failed — not installed`,
          };
        const undo = deps.setPlugin(id, { enabled: false });
        return {
          output: {
            ...base,
            tested: true,
            installed: true,
            testResult: { ok: true, passed: 3, failed: 0, output: '3 pass\n0 fail' },
            note: 'Installed turned OFF. Review the code, then turn it on in Settings → Plugins.',
          },
          summary: `Wrote and installed plugin “${id}” (turned off)`,
          undo,
        };
      },
    },
  ];
}
