// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Config service (`kernel.use('admin.config')`), §3.4 / §6.3 / §6.11:
 * versioned revisions in the DocStore (author, time, plain summary, JSON
 * patch, full snapshot), propose → plain-language diff → commit, 5-minute
 * undo, time-machine restore, YAML import/export with file-wins-on-boot, and
 * a last-known-good marker for safe mode.
 */
import {
  type BeamhopConfig,
  ConfigSchema,
  type DiffLine,
  type DocStore,
  type Kernel,
  type Principal,
  type RelayId,
  can,
} from '@beamhop/core';
import YAML from 'yaml';
import { COL } from '../settings.ts';
import type { UndoStore } from '../undo.ts';
import { HttpError, clone, deepEqual, lowerFirst, redact, seqKey } from '../util.ts';
import { describeChanges } from './describe.ts';
import { type JsonPatchOp, applyPatch, diffPatch, mergePatch, redactPatch } from './patch.ts';

export const REVISIONS = COL.revisions;
export const CONFIG_META = COL.configMeta;
export const PROPOSALS = COL.proposals;
const PROPOSAL_TTL = 3600;

export type RevisionSource = 'initial' | 'ui' | 'file' | 'undo' | 'restore' | 'import';

export interface ConfigRevision {
  revision: number;
  at: number;
  author: string;
  authorName: string;
  summary: string;
  source: RevisionSource;
  /** JSON Patch from the previous revision to this one. */
  patch: JsonPatchOp[];
  config: BeamhopConfig;
}

export type RevisionInfo = Omit<ConfigRevision, 'config' | 'patch'> & { changes: number };

export interface ConfigProposal {
  id: string;
  baseRevision: number;
  /** Relay the proposal is limited to (relay-scoped admins), or null for the whole node. */
  scope: RelayId | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  patch: JsonPatchOp[];
  diff: DiffLine[];
  summary: string;
  source: RevisionSource;
  next: BeamhopConfig;
}

export interface ProposeInput {
  /** RFC 6902 ops (relative to the relay object when `relayId` is set). */
  patch?: JsonPatchOp[];
  /** RFC 7396 merge patch (relative to the relay object when `relayId` is set). */
  merge?: unknown;
  /** Full replacement config (import). */
  replace?: unknown;
  relayId?: RelayId | null;
  summary?: string;
  source?: RevisionSource;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface CommitResult {
  revision: ConfigRevision;
  undo: { token: string; expiresAt: number };
}

export interface ConfigServiceDeps {
  kernel: Kernel;
  undo: UndoStore;
  undoWindowSeconds: () => number;
  nameOf: (principalId: string) => Promise<string>;
}

/** Public API exposed as `kernel.provide('admin.config', …)`. */
export interface AdminConfigService {
  current(): Promise<{ revision: number; config: BeamhopConfig }>;
  history(opts?: { limit?: number; cursor?: string }): Promise<{
    items: RevisionInfo[];
    cursor?: string;
  }>;
  get(revision: number): Promise<ConfigRevision | null>;
  propose(input: ProposeInput, principal: Principal): Promise<ConfigProposal>;
  commit(
    proposalId: string,
    principal: Principal,
    opts?: { summary?: string },
  ): Promise<CommitResult>;
  undo(revision: number, principal: Principal): Promise<ConfigRevision>;
  restore(revision: number, principal: Principal): Promise<CommitResult>;
  /** One-step validate + record + commit (for already-audited actions such as `config.apply-persona`). */
  apply(
    nextConfig: unknown,
    opts: { principalId: string; summary?: string; reason?: string; relayId?: RelayId | null },
  ): Promise<CommitResult & { revisionId: number }>;
  /** Plain-language diff from the current config to a past revision (time machine preview). */
  diffTo(revision: number): Promise<DiffLine[]>;
  exportYaml(revision?: number): Promise<string>;
  importYaml(text: string, principal: Principal): Promise<ConfigProposal>;
  /** File-wins-on-boot: commit the file's config as a new revision when it differs. */
  syncFromFile(text: string): Promise<{ changed: boolean; revision: number }>;
  /** Write-back hook for GitOps: called with YAML after every committed change not coming from the file. */
  setFileWriter(fn: ((yaml: string) => Promise<void>) | null): void;
  /** File-wins-on-boot for an already parsed config (runtime: `{ source: 'file', path }`). */
  adoptBootConfig(config: unknown, opts: { source: 'file'; path?: string }): Promise<void>;
  /** Mark a revision (number), a config object, or the current revision as known-good. */
  markKnownGood(target?: number | BeamhopConfig): Promise<number>;
  knownGood(): Promise<{ revision: number; config: BeamhopConfig } | null>;
  /** Safe mode: the last known-good config, or null. */
  lastKnownGood(): Promise<BeamhopConfig | null>;
}

const SYSTEM: Principal = {
  id: 'system',
  roles: { '*': 'owner' },
  via: 'cli',
  displayName: 'Beamhop',
};
const FILE: Principal = {
  id: 'file:beamhop.yaml',
  roles: { '*': 'owner' },
  via: 'cli',
  displayName: 'beamhop.yaml',
};

export function parseYamlConfig(text: string): unknown {
  try {
    return YAML.parse(text) ?? {};
  } catch (err) {
    throw new HttpError(400, 'bad_yaml', 'The file could not be read as YAML', String(err));
  }
}

export function toYaml(config: BeamhopConfig): string {
  return `# Beamhop configuration — edited in the admin app or by hand.\n${YAML.stringify(config)}`;
}

function zodIssues(err: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): ConfigIssue[] {
  return err.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

export function autoSummary(diff: DiffLine[]): string {
  const real = diff.filter((d) => d.kind !== 'warning' && d.kind !== 'info');
  if (real.length === 0) return 'No changes';
  const first = real[0]!.text;
  return real.length === 1
    ? first
    : `${first} and ${real.length - 1} more change${real.length > 2 ? 's' : ''}`;
}

/**
 * Pick the config to boot with (runtime helper, before the kernel exists):
 * safe mode → last known-good revision; otherwise the YAML file when given
 * (file wins), else the latest stored revision, else defaults.
 */
export async function resolveBootConfig(opts: {
  docs: DocStore;
  fileYaml?: string | null;
  safeMode?: boolean;
}): Promise<{
  config: BeamhopConfig;
  source: 'known-good' | 'file' | 'revision' | 'default';
  revision?: number;
}> {
  if (opts.safeMode) {
    const kg = await opts.docs.get<{ revision: number; config?: BeamhopConfig }>(
      CONFIG_META,
      'known-good',
    );
    if (kg?.config) return { config: kg.config, source: 'known-good', revision: kg.revision };
    if (kg) {
      const rev = await opts.docs.get<ConfigRevision>(REVISIONS, seqKey(kg.revision));
      if (rev) return { config: rev.config, source: 'known-good', revision: rev.revision };
    }
  }
  if (opts.fileYaml != null && opts.fileYaml.trim() !== '') {
    return { config: ConfigSchema.parse(parseYamlConfig(opts.fileYaml)), source: 'file' };
  }
  const head = (await opts.docs.list<ConfigRevision>(REVISIONS, { reverse: true, limit: 1 }))
    .items[0];
  if (head) return { config: head.value.config, source: 'revision', revision: head.value.revision };
  return { config: ConfigSchema.parse({}), source: 'default' };
}

export class ConfigService implements AdminConfigService {
  private fileWriter: ((yaml: string) => Promise<void>) | null = null;

  constructor(private readonly deps: ConfigServiceDeps) {}

  private get docs() {
    return this.deps.kernel.ports.docs;
  }
  private now() {
    return this.deps.kernel.ports.clock.now();
  }

  private async head(): Promise<ConfigRevision | null> {
    const page = await this.docs.list<ConfigRevision>(REVISIONS, { reverse: true, limit: 1 });
    return page.items[0]?.value ?? null;
  }

  private async ensureInit(): Promise<ConfigRevision> {
    const h = await this.head();
    if (h) return h;
    const rev: ConfigRevision = {
      revision: 1,
      at: this.now(),
      author: SYSTEM.id,
      authorName: 'Beamhop',
      summary: 'Initial settings',
      source: 'initial',
      patch: [],
      config: clone(this.deps.kernel.config()),
    };
    await this.docs.cas(REVISIONS, seqKey(1), null, rev);
    return (await this.head()) as ConfigRevision;
  }

  async current() {
    const h = await this.ensureInit();
    return { revision: h.revision, config: h.config };
  }

  async history(opts: { limit?: number; cursor?: string } = {}) {
    await this.ensureInit();
    const page = await this.docs.list<ConfigRevision>(REVISIONS, {
      reverse: true,
      limit: Math.min(opts.limit ?? 50, 200),
      cursor: opts.cursor,
    });
    return {
      items: page.items.map(({ value: { config: _c, patch, ...info } }) => ({
        ...info,
        changes: patch.length,
      })),
      cursor: page.cursor,
    };
  }

  get(revision: number) {
    return this.docs.get<ConfigRevision>(REVISIONS, seqKey(revision));
  }

  async propose(input: ProposeInput, principal: Principal): Promise<ConfigProposal> {
    const head = await this.ensureInit();
    const scope = input.relayId ?? null;
    if (!can(principal, 'config.write', scope))
      throw new HttpError(
        403,
        'forbidden',
        "You don't have permission to change these settings",
        'requires config.write',
      );
    const prev = head.config;
    let raw: unknown;
    try {
      if (input.replace !== undefined) {
        if (scope)
          throw new HttpError(400, 'bad_request', 'A full import must be done for the whole node');
        raw = input.replace;
      } else if (scope) {
        const idx = prev.relays.findIndex((r) => r.id === scope);
        if (idx < 0) throw new HttpError(404, 'not_found', 'That relay does not exist');
        const relay = prev.relays[idx];
        const nextRelay = input.patch
          ? applyPatch(relay, input.patch)
          : mergePatch(relay, input.merge ?? {});
        const relays = [...prev.relays] as unknown[];
        relays[idx] = nextRelay;
        raw = { ...prev, relays };
      } else if (input.patch) {
        raw = applyPatch(prev, input.patch);
      } else {
        raw = mergePatch(prev, input.merge ?? {});
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'bad_patch', 'The change could not be applied', String(err));
    }
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success)
      throw new HttpError(
        422,
        'invalid_config',
        'Some settings are not valid',
        parsed.error.message,
        zodIssues(parsed.error),
      );
    const next = parsed.data;
    this.validateModules(prev, next);
    if (scope) {
      // A relay-scoped change may only touch that relay, and may not rename it.
      const strip = (c: BeamhopConfig) => ({
        ...c,
        relays: c.relays.filter((r) => r.id !== scope),
      });
      const nextRelay = next.relays.find((r) => r.id === scope);
      if (!nextRelay || !deepEqual(strip(prev), strip(next)))
        throw new HttpError(403, 'forbidden', 'This change reaches beyond this relay');
    }
    const patch = diffPatch(prev, next);
    const diff = describeChanges(prev, next, ConfigSchema);
    const proposal: ConfigProposal = {
      id: this.deps.kernel.ports.crypto.randomHex(12),
      baseRevision: head.revision,
      scope,
      createdBy: principal.id,
      createdAt: this.now(),
      expiresAt: this.now() + PROPOSAL_TTL,
      patch,
      diff,
      summary: input.summary ?? autoSummary(diff),
      source: input.source ?? 'ui',
      next,
    };
    await this.docs.put(PROPOSALS, proposal.id, proposal);
    return proposal;
  }

  /**
   * Validate changed `modules.<id>` sections with each loaded module's own
   * `configSchema` (core config leaves them opaque). Sections of modules that are
   * not loaded on this node, and unchanged sections, are left alone.
   */
  private validateModules(prev: BeamhopConfig, next: BeamhopConfig): void {
    const schemas = this.deps.kernel.moduleSchemas?.() ?? {};
    const issues: Array<{ path: string; message: string }> = [];
    const messages: string[] = [];
    for (const [id, schema] of Object.entries(schemas)) {
      const section = next.modules[id];
      if (section === undefined || deepEqual(section, prev.modules[id])) continue;
      const r = schema.safeParse(section);
      if (r.success) continue;
      messages.push(`modules.${id}: ${r.error.message}`);
      for (const i of r.error.issues)
        issues.push({
          path: ['modules', id, ...i.path.map(String)].join('.'),
          message: i.message,
        });
    }
    if (issues.length)
      throw new HttpError(
        422,
        'invalid_config',
        'Some settings are not valid',
        messages.join('\n'),
        issues,
      );
  }

  async commit(proposalId: string, principal: Principal, opts: { summary?: string } = {}) {
    const p = await this.docs.get<ConfigProposal>(PROPOSALS, proposalId);
    if (!p || p.expiresAt < this.now())
      throw new HttpError(
        404,
        'not_found',
        'That proposed change has expired. Please review it again.',
      );
    if (!can(principal, 'config.write', p.scope))
      throw new HttpError(
        403,
        'forbidden',
        "You don't have permission to change these settings",
        'requires config.write',
      );
    if (p.patch.length === 0) throw new HttpError(400, 'no_changes', 'There is nothing to change');
    const rev = await this.write(
      p.baseRevision,
      p.next,
      principal,
      opts.summary ?? p.summary,
      p.source,
      p.scope,
      p.source === 'import' ? 'config.import' : 'config.commit',
    );
    await this.docs.delete(PROPOSALS, proposalId);
    return { revision: rev, undo: await this.undoTokenFor(rev, principal, p.scope) };
  }

  private async undoTokenFor(rev: ConfigRevision, principal: Principal, scope: RelayId | null) {
    const expiresAt = rev.at + this.deps.undoWindowSeconds();
    const token = await this.deps.undo.create({
      kind: 'config',
      principalId: principal.id,
      relayId: scope,
      expiresAt,
      revision: rev.revision,
      summary: `Undo: ${rev.summary}`,
    });
    return { token, expiresAt };
  }

  /** Write a new revision on top of `baseRevision` (optimistic concurrency) and apply it. */
  private async write(
    baseRevision: number,
    next: BeamhopConfig,
    principal: Principal,
    summary: string,
    source: RevisionSource,
    scope: RelayId | null,
    actionId: string | null,
  ): Promise<ConfigRevision> {
    const head = await this.ensureInit();
    if (head.revision !== baseRevision)
      throw new HttpError(
        409,
        'conflict',
        'Settings were changed by someone else in the meantime. Please review again.',
        `base revision ${baseRevision}, current ${head.revision}`,
      );
    const rev: ConfigRevision = {
      revision: head.revision + 1,
      at: this.now(),
      author: principal.id,
      authorName: principal.displayName ?? (await this.deps.nameOf(principal.id)),
      summary,
      source,
      patch: diffPatch(head.config, next),
      config: clone(next),
    };
    if (!(await this.docs.cas(REVISIONS, seqKey(rev.revision), null, rev)))
      throw new HttpError(
        409,
        'conflict',
        'Settings were changed by someone else in the meantime.',
      );
    try {
      await this.deps.kernel.applyConfig(rev.config);
    } catch (err) {
      await this.docs.delete(REVISIONS, seqKey(rev.revision));
      await this.deps.kernel.applyConfig(head.config).catch(() => {});
      throw new HttpError(
        500,
        'apply_failed',
        'The change could not be applied, nothing was changed',
        String(err),
      );
    }
    const bus = this.deps.kernel.bus;
    bus.emit('config.changed', { revision: rev.revision, principalId: principal.id, summary });
    if (actionId)
      bus.emit('admin.action', {
        relayId: scope,
        actionId,
        principalId: principal.id,
        input: { revision: rev.revision, patch: redactPatch(rev.patch) },
        summary: actionSentence(actionId, summary),
        ok: true,
      });
    if (source !== 'file' && this.fileWriter) {
      try {
        await this.fileWriter(toYaml(rev.config));
      } catch (err) {
        this.deps.kernel.ports.logger.log('warn', 'config file write-back failed', {
          error: String(err),
        });
      }
    }
    return rev;
  }

  async undo(revision: number, principal: Principal): Promise<ConfigRevision> {
    const head = await this.ensureInit();
    const rev = await this.get(revision);
    if (!rev || rev.revision <= 1) throw new HttpError(404, 'not_found', 'Nothing to undo');
    if (head.revision !== revision)
      throw new HttpError(
        409,
        'conflict',
        'Settings changed since then. Use the history to restore instead.',
      );
    if (this.now() > rev.at + this.deps.undoWindowSeconds())
      throw new HttpError(
        410,
        'undo_expired',
        'It is too late to undo this. Use the history to restore instead.',
      );
    const prev = await this.get(revision - 1);
    if (!prev) throw new HttpError(404, 'not_found', 'Previous settings are missing');
    const scope = this.scopeOf(prev.config, rev.config);
    if (!can(principal, 'config.write', scope))
      throw new HttpError(
        403,
        'forbidden',
        "You don't have permission to undo this",
        'requires config.write',
      );
    return this.write(
      head.revision,
      prev.config,
      principal,
      `Undid “${rev.summary}”`,
      'undo',
      scope,
      'config.undo',
    );
  }

  /**
   * Validate, record and commit a full next config in one step (for actions such as
   * `config.apply-persona` that already did their own preview/permission checks and
   * are audited themselves). Returns the revision and an undo token.
   */
  async apply(
    nextConfig: unknown,
    opts: { principalId: string; summary?: string; reason?: string; relayId?: RelayId | null },
  ): Promise<CommitResult & { revisionId: number }> {
    const head = await this.ensureInit();
    const parsed = ConfigSchema.safeParse(nextConfig);
    if (!parsed.success)
      throw new HttpError(
        422,
        'invalid_config',
        'Some settings are not valid',
        parsed.error.message,
        zodIssues(parsed.error),
      );
    if (deepEqual(head.config, parsed.data))
      throw new HttpError(400, 'no_changes', 'There is nothing to change');
    this.validateModules(head.config, parsed.data);
    const rec = opts.principalId.startsWith('token:')
      ? null
      : await this.deps.nameOf(opts.principalId);
    const principal: Principal = {
      id: opts.principalId,
      roles: { '*': 'owner' },
      via: 'cli',
      displayName: rec ?? opts.principalId,
    };
    const diff = describeChanges(head.config, parsed.data, ConfigSchema);
    const summary = opts.summary ?? autoSummary(diff);
    const scope = opts.relayId ?? this.scopeOf(head.config, parsed.data);
    const rev = await this.write(head.revision, parsed.data, principal, summary, 'ui', scope, null);
    const undo = await this.undoTokenFor(rev, principal, scope);
    return { revision: rev, undo, revisionId: rev.revision };
  }

  async restore(revision: number, principal: Principal) {
    const head = await this.ensureInit();
    const target = await this.get(revision);
    if (!target) throw new HttpError(404, 'not_found', 'That revision does not exist');
    if (!can(principal, 'config.write', null))
      throw new HttpError(
        403,
        'forbidden',
        "You don't have permission to restore settings",
        'requires config.write',
      );
    if (deepEqual(head.config, target.config))
      throw new HttpError(400, 'no_changes', 'These settings are already in use');
    const rev = await this.write(
      head.revision,
      target.config,
      principal,
      `Restored settings from revision ${revision}`,
      'restore',
      null,
      'config.restore',
    );
    return { revision: rev, undo: await this.undoTokenFor(rev, principal, null) };
  }

  async diffTo(revision: number) {
    const head = await this.ensureInit();
    const target = await this.get(revision);
    if (!target) throw new HttpError(404, 'not_found', 'That revision does not exist');
    return describeChanges(head.config, target.config, ConfigSchema);
  }

  /** The single relay a change is confined to, or null when it touches node-level settings. */
  private scopeOf(a: BeamhopConfig, b: BeamhopConfig): RelayId | null {
    const changed = a.relays.filter(
      (r) =>
        !deepEqual(
          r,
          b.relays.find((x) => x.id === r.id),
        ),
    );
    if (changed.length !== 1 || a.relays.length !== b.relays.length) return null;
    const id = changed[0]!.id;
    const strip = (c: BeamhopConfig) => ({ ...c, relays: c.relays.filter((r) => r.id !== id) });
    return deepEqual(strip(a), strip(b)) ? id : null;
  }

  async exportYaml(revision?: number) {
    const cfg = revision ? (await this.get(revision))?.config : (await this.current()).config;
    if (!cfg) throw new HttpError(404, 'not_found', 'That revision does not exist');
    return toYaml(cfg);
  }

  async importYaml(text: string, principal: Principal) {
    return this.propose(
      {
        replace: parseYamlConfig(text),
        source: 'import',
        summary: 'Imported settings from a file',
      },
      principal,
    );
  }

  async syncFromFile(text: string) {
    return this.adopt(parseYamlConfig(text), 'beamhop.yaml');
  }

  async adoptBootConfig(config: unknown, opts: { source: 'file'; path?: string }): Promise<void> {
    await this.adopt(
      config,
      opts.path ? opts.path.split(/[\\/]/).pop() || opts.path : 'beamhop.yaml',
    );
  }

  private async adopt(raw: unknown, fileName: string) {
    const head = await this.ensureInit();
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success)
      throw new HttpError(
        422,
        'invalid_config',
        `${fileName} has invalid settings`,
        parsed.error.message,
        zodIssues(parsed.error),
      );
    if (deepEqual(head.config, parsed.data)) {
      if (!deepEqual(this.deps.kernel.config(), parsed.data))
        await this.deps.kernel.applyConfig(parsed.data);
      return { changed: false, revision: head.revision };
    }
    const diff = describeChanges(head.config, parsed.data, ConfigSchema);
    const author: Principal = { ...FILE, id: `file:${fileName}`, displayName: fileName };
    const rev = await this.write(
      head.revision,
      parsed.data,
      author,
      `${fileName}: ${lowerFirst(autoSummary(diff))}`,
      'file',
      null,
      'config.file-sync',
    );
    return { changed: true, revision: rev.revision };
  }

  setFileWriter(fn: ((yaml: string) => Promise<void>) | null) {
    this.fileWriter = fn;
  }

  /**
   * Mark a known-good config for safe mode: a revision number, a config object
   * (matched against the latest revisions, else stored as a snapshot), or the
   * current revision when omitted.
   */
  async markKnownGood(target?: number | BeamhopConfig): Promise<number> {
    const head = await this.ensureInit();
    if (target === undefined || typeof target === 'number') {
      const rev = target ?? head.revision;
      if (!(await this.get(rev)))
        throw new HttpError(404, 'not_found', 'That revision does not exist');
      await this.docs.put(CONFIG_META, 'known-good', { revision: rev, at: this.now() });
      return rev;
    }
    const page = await this.docs.list<ConfigRevision>(REVISIONS, { reverse: true, limit: 20 });
    const hit = page.items.find((i) => deepEqual(i.value.config, target));
    if (hit) {
      await this.docs.put(CONFIG_META, 'known-good', {
        revision: hit.value.revision,
        at: this.now(),
      });
      return hit.value.revision;
    }
    await this.docs.put(CONFIG_META, 'known-good', {
      revision: 0,
      config: clone(target),
      at: this.now(),
    });
    return 0;
  }

  async knownGood(): Promise<{ revision: number; config: BeamhopConfig } | null> {
    const kg = await this.docs.get<{ revision: number; config?: BeamhopConfig }>(
      CONFIG_META,
      'known-good',
    );
    if (!kg) return null;
    if (kg.config) return { revision: kg.revision, config: kg.config };
    const rev = await this.get(kg.revision);
    return rev ? { revision: rev.revision, config: rev.config } : null;
  }

  async lastKnownGood(): Promise<BeamhopConfig | null> {
    return (await this.knownGood())?.config ?? null;
  }

  async gc(): Promise<void> {
    const now = this.now();
    const page = await this.docs.list<ConfigProposal>(PROPOSALS, { limit: 1000 });
    for (const i of page.items)
      if (i.value.expiresAt < now) await this.docs.delete(PROPOSALS, i.key);
  }
}

function actionSentence(actionId: string, summary: string): string {
  switch (actionId) {
    case 'config.undo':
      return summary;
    case 'config.restore':
      return summary;
    case 'config.file-sync':
      return `Settings updated from ${summary}`;
    default:
      return `Changed settings: ${lowerFirst(summary)}`;
  }
}
