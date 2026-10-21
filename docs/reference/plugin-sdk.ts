// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builds docs/reference/plugin-sdk.md from the plugin SDK itself (used by generate.ts):
 *
 * - exported declarations and their TSDoc, read with the TypeScript compiler API from
 *   `packages/plugins/src/sdk` and `packages/plugins/src/testing` (the public entry points
 *   `@beamhop/plugins/sdk` and `@beamhop/plugins/testing`);
 * - the zod `ManifestSchema` (rules) and `definePlugin` (defaults) for the manifest table;
 * - `PERMISSION_TEXT` for the permission table, `SDK_GUIDE` for the AI generator notes;
 * - the built-in keyword filter and its tests as the worked example, so it stays correct.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  HOOK_NAMES,
  ManifestSchema,
  PERMISSION_TEXT,
  type PluginPermission,
  SDK_GUIDE,
  definePlugin,
  permissionLines,
} from '../../packages/plugins/src/index.ts';

const ROOT = join(import.meta.dir, '..', '..');
const PLUGINS = join(ROOT, 'packages', 'plugins');
const ENTRY_SDK = join(PLUGINS, 'src', 'sdk', 'index.ts');
const ENTRY_TESTING = join(PLUGINS, 'src', 'testing', 'index.ts');
const EXAMPLE_SOURCE = join(PLUGINS, 'src', 'builtin', 'keyword-filter.ts');
const EXAMPLE_TEST = join(PLUGINS, 'test', 'builtin.test.ts');

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const code = (s: string) => `\`${esc(s)}\``;

// ── TypeScript: exported declarations + TSDoc ────────────────────────────────
type Decl = ts.Declaration & { name?: ts.Node };

class Api {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly decls = new Map<string, Decl>();

  constructor(entries: string[]) {
    this.program = ts.createProgram(entries, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    this.checker = this.program.getTypeChecker();
    for (const entry of entries) {
      const sf = this.program.getSourceFile(entry);
      const mod = sf && this.checker.getSymbolAtLocation(sf);
      if (!mod) throw new Error(`plugin SDK entry not found: ${entry}`);
      for (const exp of this.checker.getExportsOfModule(mod)) {
        const sym = exp.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exp) : exp;
        const decl = sym.declarations?.[0] as Decl | undefined;
        if (decl && !this.decls.has(exp.name)) this.decls.set(exp.name, decl);
      }
    }
  }

  /** Exported declaration by name (throws if the SDK no longer exports it). */
  decl(name: string): Decl {
    const d = this.decls.get(name);
    if (!d) throw new Error(`plugin SDK does not export ${name}`);
    return d;
  }

  /** TSDoc text of a declaration (or of the statement holding a variable). */
  doc(node: ts.Node): string {
    const target = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    const parts = ts
      .getJSDocCommentsAndTags(target)
      .filter(ts.isJSDoc)
      .map((d) => ts.getTextOfJSDocComment(d.comment) ?? '')
      .filter(Boolean);
    return tidyDoc(parts.join('\n\n'));
  }

  /** One-line signature of a function, arrow-function constant or interface member. */
  signature(node: ts.Node): string {
    const sf = node.getSourceFile();
    if (ts.isFunctionDeclaration(node)) {
      const end = node.body ? node.body.getStart(sf) : node.getEnd();
      const text = sf.text.slice(node.getStart(sf), end).replace(/^export\s+(async\s+)?/, '');
      return oneLine(text.replace(/^function\s+/, ''));
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init)) {
        const params = init.parameters.map((p) => p.getText(sf)).join(', ');
        const ret = init.type ? `: ${init.type.getText(sf)}` : '';
        return oneLine(`${node.name.getText(sf)}(${params})${ret}`);
      }
    }
    return oneLine(node.getText(sf)).replace(/;$/, '');
  }

  /** Members of an exported interface: name, signature and TSDoc. */
  members(name: string): Array<{ name: string; signature: string; doc: string }> {
    const d = this.decl(name);
    if (!ts.isInterfaceDeclaration(d)) throw new Error(`${name} is not an interface`);
    return d.members.map((m) => ({
      name: m.name?.getText(d.getSourceFile()) ?? '',
      signature: this.signature(m),
      doc: this.doc(m),
    }));
  }

  /** Text of an exported type alias (`type X = …`), one line. */
  typeText(name: string): string {
    const d = this.decl(name);
    if (!ts.isTypeAliasDeclaration(d)) throw new Error(`${name} is not a type alias`);
    return oneLine(d.getText(d.getSourceFile())).replace(/^export\s+/, '');
  }
}

function oneLine(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/,\s*\)/g, ')')
    .replace(/\s+\)/g, ')')
    .replace(/<\s+/g, '<')
    .replace(/,\s*>/g, '>')
    .replace(/\s+>/g, '>')
    .replace(/\{\s+/g, '{ ')
    .replace(/;\s*\}/g, ' }')
    .replace(/([:=])\s*\|\s*/g, '$1 ')
    .replace(/,\s*\}/g, ' }')
    .trim();
}

function tidyDoc(s: string): string {
  return s
    .replace(/\{@link\s+([^}\s]+)\s*\}/g, '`$1`')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

/** Paragraphs → one markdown table cell. */
const cell = (s: string) => esc(s.replace(/\n\n/g, '<br>').replace(/\n/g, ' '));

function memberTable(api: Api, name: string, first = 'Member'): string {
  const rows = api.members(name);
  const lines = [`| ${first} | Signature | Description |`, '|---|---|---|'];
  for (const r of rows) lines.push(`| \`${r.name}\` | ${code(r.signature)} | ${cell(r.doc)} |`);
  return `${lines.join('\n')}\n`;
}

function fnBlock(api: Api, name: string): string {
  const d = api.decl(name);
  return `\`\`\`ts\n${api.signature(d)}\n\`\`\`\n\n${api.doc(d)}\n`;
}

// ── zod: manifest rules ──────────────────────────────────────────────────────
interface ZodLike {
  _zod: { def: { type: string; checks?: ZodLike[]; element?: ZodLike; entries?: object } };
}
interface CheckDef {
  check: string;
  pattern?: RegExp;
  minimum?: number;
  maximum?: number;
  value?: number;
  format?: string;
}

function rule(schema: ZodLike): string {
  const def = schema._zod.def;
  const checks = (def.checks ?? []).map((c) => c._zod.def as unknown as CheckDef);
  const out: string[] = [];
  if (def.type === 'array' && def.element) {
    const values = Object.values(def.element._zod.def.entries ?? {}) as string[];
    out.push(`list of ${values.map((v) => `\`${v}\``).join(', ')}`);
  } else if (def.type === 'number') {
    out.push(checks.some((c) => c.format === 'safeint') ? 'whole number' : 'number');
  } else out.push(def.type);
  for (const c of checks) {
    if (c.check === 'string_format' && c.pattern) out.push(`matching \`${c.pattern.source}\``);
    if (c.check === 'min_length') out.push(`at least ${c.minimum}`);
    if (c.check === 'max_length') out.push(`at most ${c.maximum}`);
    if (c.check === 'greater_than') out.push(`≥ ${c.value}`);
    if (c.check === 'less_than') out.push(`≤ ${c.value}`);
  }
  return out.join(', ');
}

function manifestTable(api: Api): string {
  const docs = new Map(api.members('PluginManifest').map((m) => [m.name, m.doc]));
  const defaults = definePlugin({ id: 'defaults', name: 'Defaults', description: '' }).manifest;
  const required = new Set(['id', 'name', 'description']);
  const lines = ['| Field | Rule | Default | Description |', '|---|---|---|---|'];
  for (const [field, schema] of Object.entries(ManifestSchema.shape)) {
    const def = required.has(field)
      ? '*required*'
      : `\`${JSON.stringify((defaults as unknown as Record<string, unknown>)[field])}\``;
    lines.push(
      `| \`${field}\` | ${esc(rule(schema as unknown as ZodLike))} | ${def} | ${cell(docs.get(field) ?? '')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── worked example ───────────────────────────────────────────────────────────
function exampleSource(): string {
  const src = readFileSync(EXAMPLE_SOURCE, 'utf8');
  return src.replace("from '../sdk/index.ts'", "from '@beamhop/plugins/sdk'");
}

function exampleTest(): string {
  const src = readFileSync(EXAMPLE_TEST, 'utf8');
  const start = src.indexOf("describe('keyword-filter'");
  if (start < 0) throw new Error('worked example test (describe keyword-filter) not found');
  const end = src.indexOf('\n});\n', start);
  const block = src.slice(start, end + 4);
  return [
    "import { describe, expect, test } from 'bun:test';",
    "import { createPluginTestbed, expectAccept, expectReject } from '@beamhop/plugins/testing';",
    "import { keywordFilterPlugin } from './index.ts';",
    '',
    block,
  ].join('\n');
}

// ── page ─────────────────────────────────────────────────────────────────────
export function pluginSdkPage(header: (what: string, from: string) => string): string {
  const api = new Api([ENTRY_SDK, ENTRY_TESTING]);
  let md = header(
    'Plugin SDK reference',
    'the plugin SDK source (packages/plugins/src/sdk, packages/plugins/src/testing) and its TSDoc',
  );
  md +=
    'A plugin is a small set of **policy hooks** that look at activity on your relay (new posts, ' +
    'subscriptions, sign-ins, uploads) and decide: let it through, refuse it, hide it quietly, or ' +
    'hold it for review. The same plugin runs in-process (built-in and trusted plugins, Cloudflare ' +
    'bundles) or in a sandboxed worker with a time budget (everything else), so hooks only ever ' +
    'see plain data. For a walk-through see [`packages/plugins/README.md`](../../packages/plugins/README.md).\n\n';
  md += '| Import | What |\n|---|---|\n';
  md += '| `@beamhop/plugins/sdk` | `definePlugin`, decision helpers, types |\n';
  md +=
    '| `@beamhop/plugins/testing` (alias `@beamhop/plugins/testbed`) | test harness and assertions |\n\n';

  md += '## Defining a plugin\n\n';
  md += fnBlock(api, 'definePlugin');
  md += `\n${api.doc(api.decl('PluginInput'))}\n\n`;
  md += memberTable(api, 'PluginSpec', 'Field');

  md += '\n## Manifest\n\n';
  md += `${api.doc(api.decl('ManifestSchema'))}\n\n`;
  md += manifestTable(api);
  md += `\n${api.doc(api.decl('PLUGIN_BAND'))} The hook id in the pipeline is \`plugin.<id>\`.\n`;

  md += '\n## Hooks\n\n';
  md += `${api.doc(api.decl('PluginHooks'))}\n`;
  const hooks = new Map(api.members('PluginHooks').map((m) => [m.name, m]));
  for (const name of HOOK_NAMES) {
    const h = hooks.get(name);
    if (!h) throw new Error(`hook ${name} has no PluginHooks member`);
    md += `\n### ${name}\n\n\`\`\`ts\n${h.signature}\n\`\`\`\n\n${h.doc}\n`;
  }

  md += '\n## What a hook returns\n\n';
  md += `\`\`\`ts\n${api.typeText('HookResult')}\n\`\`\`\n\n${api.doc(api.decl('HookResult'))}\n`;
  for (const name of ['accept', 'reject', 'shadow', 'hold'])
    md += `\n### ${name}\n\n${fnBlock(api, name)}`;

  md += '\n## Hook context\n\n';
  md += `${api.doc(api.decl('PluginHookContext'))} It extends the plain context below.\n\n`;
  md += memberTable(api, 'PluginHookContext');
  md += `\n**\`CtxView\`**: ${api.doc(api.decl('CtxView'))}\n\n`;
  md += memberTable(api, 'CtxView');
  md += `\n**\`ConnView\`**: ${api.doc(api.decl('ConnView'))}\n\n`;
  md += memberTable(api, 'ConnView');

  md += '\n## Plugin API (`ctx.api`)\n\n';
  md += `${api.doc(api.decl('PluginApi'))}\n\n`;
  md += memberTable(api, 'PluginApi');
  md += `\n**\`api.events\`**: ${api.doc(api.decl('PluginEventsApi'))}\n\n`;
  md += memberTable(api, 'PluginEventsApi');
  md += `\n**\`api.docs\`**: ${api.doc(api.decl('PluginDocsApi'))}\n\n`;
  md += memberTable(api, 'PluginDocsApi');

  md += '\n## Permissions\n\n';
  md += `${api.doc(api.decl('PluginPermission'))} `;
  md +=
    'Risky ones are shown as a warning. Calling something the plugin did not ask for throws ' +
    '`PluginPermissionError`. AI-written plugins are installed without permissions.\n\n';
  md += '| Permission | What admins see | Technical | Risky |\n|---|---|---|---|\n';
  for (const [perm, t] of Object.entries(PERMISSION_TEXT) as Array<
    [PluginPermission, (typeof PERMISSION_TEXT)[PluginPermission]]
  >) {
    md += `| \`${perm}\` | ${esc(t.text)} | ${esc(t.technical)} | ${t.risky ? 'yes' : 'no'} |\n`;
  }
  const none = permissionLines([])[0];
  if (none) md += `| *(none)* | ${esc(none.text)} | ${esc(none.technical ?? '')} | no |\n`;

  md += '\n## Test harness\n\n';
  md += fnBlock(api, 'createPluginTestbed');
  md += `\n**\`TestbedOptions\`**: ${api.doc(api.decl('TestbedOptions'))}\n\n`;
  md += memberTable(api, 'TestbedOptions', 'Option');
  md += `\n**\`PluginTestbed\`**: ${api.doc(api.decl('PluginTestbed'))}\n\n`;
  md += memberTable(api, 'PluginTestbed');
  md += `\n**\`CtxInput\`**: ${api.doc(api.decl('CtxInput'))}\n\n`;
  md += memberTable(api, 'CtxInput', 'Field');
  md += `\n**\`EventInput\`**: ${api.doc(api.decl('EventInput'))}\n\n`;
  md += `\`\`\`ts\n${api.typeText('EventInput')}\n\`\`\`\n`;
  md +=
    '\n### Assertions\n\nFramework-agnostic: they throw, so they work with `bun:test` or anything else.\n';
  for (const name of ['expectAccept', 'expectReject', 'expectDecision'])
    md += `\n${fnBlock(api, name)}`;
  md += '\n### Short form\n\n';
  md += fnBlock(api, 'createTestbed');
  md += `\n**\`SimpleTestbed\`**: ${api.doc(api.decl('SimpleTestbed'))}\n\n`;
  md += memberTable(api, 'SimpleTestbed');
  md += '\n### What the AI plugin generator is told about the host\n\n';
  md +=
    '`ai.generate-plugin` adds these host notes to its prompt (from `SDK_GUIDE` in ' +
    '`packages/plugins/src/host/host.ts`), then runs the generated tests in the sandbox before ' +
    'anything is installed:\n\n';
  md += `\`\`\`text\n${SDK_GUIDE}\n\`\`\`\n`;

  md += '\n## Worked example\n\n';
  md +=
    'The built-in **Block words and phrases** plugin (`packages/plugins/src/builtin/keyword-filter.ts`), ' +
    'copied here at generation time with the import pointed at the public SDK. It uses a settings ' +
    'schema with defaults, a hooks factory (patterns are compiled once per instance and again on ' +
    'every settings change), and all three non-accept decisions.\n\n';
  md += `\`\`\`ts\n${exampleSource().trimEnd()}\n\`\`\`\n\n`;
  md +=
    'Its tests (`packages/plugins/test/builtin.test.ts`), run by `bun test` on every change:\n\n';
  md += `\`\`\`ts\n${exampleTest().trimEnd()}\n\`\`\`\n\n`;
  md +=
    'Turn it on in `beamhop.yaml` (or from the Plugins screen in the admin app):\n\n' +
    '```yaml\nplugins:\n  - id: keyword-filter\n    enabled: true\n    config:\n      keywords: [buy now]\n      action: hold\n```\n';
  return md;
}
