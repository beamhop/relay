// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { parseFlags } from '../src/args.ts';
import {
  type Catalog,
  type CatalogEntry,
  actionFields,
  actionHelp,
  buildInput,
  catalogSummary,
  fieldFlagSpecs,
  groupHelp,
  groups,
  matchAction,
} from '../src/catalog.ts';
import { mainHelp } from '../src/cli.ts';
import { completionScript } from '../src/commands/completion.ts';

const schema = (s: z.ZodType) =>
  z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as CatalogEntry['inputSchema'];

function entry(id: string, input: z.ZodType, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    title: extra.title ?? id,
    description: extra.description ?? `Does ${id}`,
    scope: 'node',
    permission: 'config.write',
    readOnly: false,
    bulk: false,
    undoable: true,
    inputSchema: schema(input),
    ...extra,
  };
}

/** Sample catalog shaped exactly like admin-api's `/actions` output (zod → JSON Schema). */
const SAMPLE: Catalog = {
  actions: [
    entry(
      'admins.invite',
      z.object({
        pubkey: z.string().describe('Their npub or hex key'),
        role: z.enum(['owner', 'admin', 'moderator', 'viewer']).describe('What they may do'),
        relayId: z.string().optional().describe('Only this relay'),
        displayName: z.string().max(80).optional(),
      }),
      { title: 'Invite an admin', permission: 'admins.manage', technical: 'kind 0 lookup' },
    ),
    entry('admins.list', z.object({}), { title: 'Show the team', readOnly: true, undoable: false }),
    entry(
      'tokens.create',
      z.object({
        name: z.string().min(1).max(80).describe('What it is for'),
        scopes: z
          .array(z.enum(['relay.read', 'config.write']))
          .min(1)
          .optional(),
        expiresInDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(90)
          .describe('Days until it stops working'),
      }),
      { title: 'Create an API token' },
    ),
    entry(
      'moderation.ban-pubkey',
      z.object({
        pubkeys: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
        reason: z.string().optional(),
        removeRecent: z.boolean().default(false).describe('Also remove their recent posts'),
        json: z.unknown().optional().describe('Collides with --json'),
      }),
      { title: 'Block account', scope: 'relay', bulk: true },
    ),
    entry('media.quota.set', z.object({ bytes: z.number().int().nonnegative() }), {
      title: 'Set a quota',
    }),
  ],
};

describe('schema → flags', () => {
  test('types, enums, required, defaults and reserved names', () => {
    const f = actionFields(SAMPLE.actions[3]!);
    expect(f.map((x) => [x.flag, x.type, x.required])).toEqual([
      ['pubkeys', 'array', true],
      ['reason', 'string', false],
      ['remove-recent', 'boolean', false],
      ['in-json', 'json', false],
    ]);
    const t = actionFields(SAMPLE.actions[2]!);
    expect(t.find((x) => x.prop === 'expiresInDays')).toMatchObject({
      flag: 'expires-in-days',
      type: 'integer',
      required: false,
      default: 90,
    });
    expect(t.find((x) => x.prop === 'scopes')?.itemEnum).toEqual(['relay.read', 'config.write']);
  });

  test('flag parsing and validation against the schema', () => {
    const fields = actionFields(SAMPLE.actions[2]!);
    const specs = fieldFlagSpecs(fields);
    const ok = parseFlags(
      ['--name', 'ci', '--scopes', 'relay.read,config.write', '--expiresInDays=30'],
      specs,
    );
    expect(buildInput(fields, ok.flags)).toEqual({
      input: { name: 'ci', scopes: ['relay.read', 'config.write'], expiresInDays: 30 },
      issues: [],
    });
    const bad = buildInput(
      fields,
      parseFlags(['--name', '', '--scopes', 'root', '--expires-in-days', '1.5'], specs).flags,
    );
    expect(bad.issues.map((i) => `${i.flag} ${i.message}`)).toEqual([
      'name must not be empty',
      'scopes must be one of: relay.read, config.write (got "root")',
      'expires-in-days must be a whole number (got 1.5)',
    ]);
    expect(buildInput(fields, {}).issues).toEqual([{ flag: 'name', message: 'is required' }]);

    const ban = actionFields(SAMPLE.actions[3]!);
    const parsed = parseFlags(
      [
        '--pubkeys',
        'a'.repeat(64),
        '--pubkeys',
        'b'.repeat(64),
        '--no-remove-recent',
        '--in-json',
        '{"x":1}',
      ],
      fieldFlagSpecs(ban),
    );
    expect(buildInput(ban, parsed.flags).input).toEqual({
      pubkeys: ['a'.repeat(64), 'b'.repeat(64)],
      removeRecent: false,
      json: { x: 1 },
    });
    expect(buildInput(ban, { pubkeys: ['zz'] }).issues[0]!.message).toContain('wrong format');
    expect(buildInput(ban, { 'in-json': '{nope' }).issues).toContainEqual({
      flag: 'in-json',
      message: 'must be valid JSON',
    });
  });

  test('parser basics', () => {
    const specs = [
      { name: 'yes', type: 'boolean' as const, short: 'y' },
      { name: 'url', type: 'string' as const },
    ];
    expect(parseFlags(['a', '-y', '--url=http://x', 'b'], specs)).toEqual({
      flags: { yes: true, url: 'http://x' },
      positionals: ['a', 'b'],
      rest: ['a', 'b'],
    });
    expect(() => parseFlags(['--url'], specs)).toThrow('--url needs a value');
    expect(() => parseFlags(['--what'], specs)).toThrow('Unknown option --what');
    expect(parseFlags(['--what', 'x', '--yes'], specs, { allowUnknown: true }).rest).toEqual([
      '--what',
      'x',
    ]);
    expect(parseFlags(['--', '--yes'], specs).positionals).toEqual(['--yes']);
  });

  test('command matching uses the longest dotted id', () => {
    expect(matchAction(SAMPLE, ['media', 'quota', 'set', '--bytes', '1'])?.entry.id).toBe(
      'media.quota.set',
    );
    expect(matchAction(SAMPLE, ['admins', 'invite'])?.consumed).toBe(2);
    expect(matchAction(SAMPLE, ['admins'])).toBeNull();
    expect([...groups(SAMPLE).keys()]).toEqual(['admins', 'media', 'moderation', 'tokens']);
  });
});

describe('generated help and completion (snapshots)', () => {
  test('action and group help', () => {
    expect(actionHelp(SAMPLE.actions[0]!, true)).toMatchSnapshot();
    expect(actionHelp(SAMPLE.actions[3]!)).toMatchSnapshot();
    expect(groupHelp('admins', groups(SAMPLE).get('admins')!)).toMatchSnapshot();
    expect(catalogSummary(SAMPLE)).toMatchSnapshot();
  });

  test('bash, zsh and fish completion', () => {
    expect(completionScript('bash', SAMPLE)).toMatchSnapshot();
    expect(completionScript('zsh', SAMPLE)).toMatchSnapshot();
    expect(completionScript('fish', SAMPLE)).toMatchSnapshot();
    expect(completionScript('tcsh', SAMPLE)).toBeNull();
    // Built-ins still complete when the catalog is unavailable.
    expect(completionScript('bash', null)).toContain("'doctor') words_='--fix';;");
  });

  test('bash completion script is valid shell', async () => {
    const script = completionScript('bash', SAMPLE)!;
    const proc = Bun.spawn(['bash', '-n'], {
      stdin: new TextEncoder().encode(script),
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
  });

  test('main help mentions every built-in', () => {
    const h = mainHelp();
    for (const c of [
      'init',
      'doctor',
      'login',
      'status',
      'config',
      'backup',
      'update',
      'rollback',
      'claim-code',
      'move',
      'undo',
      'completion',
    ])
      expect(h).toContain(c);
  });
});
