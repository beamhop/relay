// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GitOps write-back (§3.4): settings changed in the admin app are written back to the
 * `beamhop.yaml` the server was started from, so the file stays the source of truth.
 *
 * - Only the settings that actually changed are edited, in place, in the parsed YAML
 *   document: comments, key order and untouched values (including `${VAR}` references)
 *   stay as they were.
 * - Values that came from `BEAMHOP_*` env vars, CLI flags or `${VAR}` references are
 *   never written back as plain values (they are reported instead).
 * - Writes are atomic (temp file in the same directory + rename), keep the file mode,
 *   and are serialized.
 * - A file that can't be written (read-only mount, ConfigMap) never fails the change:
 *   it is logged once and shown as an attention card.
 */
import { createHash } from 'node:crypto';
import {
  constants,
  type Stats,
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AttentionCard, BeamhopConfig, Kernel, Logger } from '@beamhop/core';
import YAML from 'yaml';

/** Service id: `kernel.use<ConfigFileWriter>(CONFIG_FILE_SERVICE)`. */
export const CONFIG_FILE_SERVICE = 'runtime.config-file';

export type ConfigPath = Array<string | number>;

export interface ConfigWriteBackOptions {
  /** The YAML file the server was started from. */
  path: string;
  /** Config paths set by env vars or CLI flags (not by the file); never written back. */
  overridePaths?: ConfigPath[];
  logger: Logger;
  now?: () => number;
}

export interface ConfigWriteBackStatus {
  path: string;
  /** Unix seconds of the last successful write. */
  lastWriteAt?: number;
  /** Last write failure (cleared by the next successful write). */
  error?: { code: string; message: string };
  /** Changed settings that were deliberately not written to the file. */
  skipped: string[];
}

interface Op {
  path: ConfigPath;
  /** `undefined` removes the key. */
  value: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON-normalize (drops `undefined` members) so comparisons match the YAML round-trip. */
const normalize = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Leaf-level differences between two config trees (arrays of different length are replaced whole). */
export function configDiff(a: unknown, b: unknown, path: ConfigPath = [], out: Op[] = []): Op[] {
  if (sameJson(a, b)) return out;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      configDiff(a[k], b[k], [...path, k], out);
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) configDiff(a[i], b[i], [...path, i], out);
  } else {
    out.push({ path, value: b });
  }
  return out;
}

function getAt(obj: unknown, path: ConfigPath): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

const startsWith = (p: ConfigPath, prefix: ConfigPath) =>
  prefix.length <= p.length && prefix.every((k, i) => String(k) === String(p[i]));

const pathText = (p: ConfigPath) => p.map(String).join('.') || '(all settings)';

const REF = /\$\{/;

/** True when the YAML node at `path` (or anything below it) holds a `${VAR}` reference. */
function hasReference(doc: YAML.Document, path: ConfigPath): boolean {
  let node: unknown;
  try {
    node = doc.getIn(path, true);
  } catch {
    return false;
  }
  if (node === undefined || node === null) return false;
  let found = false;
  const check = (n: unknown) => {
    if (YAML.isScalar(n) && typeof n.value === 'string' && REF.test(n.value)) found = true;
  };
  if (YAML.isNode(node)) {
    check(node);
    YAML.visit(node, {
      Scalar(_k, n) {
        check(n);
        if (found) return YAML.visit.BREAK;
      },
    });
  }
  return found;
}

/** Set `path` in the document, replacing the first missing/non-collection ancestor with the full subtree. */
function setIn(doc: YAML.Document, path: ConfigPath, next: unknown): void {
  for (let i = 0; i < path.length; i++) {
    const prefix = path.slice(0, i + 1);
    if (i === path.length - 1) {
      doc.setIn(prefix, getAt(next, prefix));
      return;
    }
    const node = doc.getIn(prefix, true);
    if (!YAML.isCollection(node)) {
      doc.setIn(prefix, getAt(next, prefix));
      return;
    }
  }
}

function deleteIn(doc: YAML.Document, path: ConfigPath): void {
  try {
    if (doc.hasIn(path)) doc.deleteIn(path);
  } catch {
    // Parent is not a collection: nothing to remove.
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function errCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'ERROR';
}

/** Writes admin-app changes back into the boot YAML file. Use {@link installConfigWriteBack}. */
export class ConfigFileWriter {
  private baseline: unknown;
  private chain: Promise<void> = Promise.resolve();
  private lastHash: string | null = null;
  private loggedCodes = new Set<string>();
  private readonly skipped = new Set<string>();
  private state: Omit<ConfigWriteBackStatus, 'skipped' | 'path'> = {};

  constructor(
    private readonly opts: ConfigWriteBackOptions,
    baseline: BeamhopConfig,
  ) {
    this.baseline = normalize(baseline);
  }

  get path(): string {
    return this.opts.path;
  }

  /** The `setFileWriter` callback: receives the full YAML of the new revision. */
  write = (yaml: string): Promise<void> => {
    const run = this.chain.then(() => this.apply(yaml));
    this.chain = run.catch(() => {});
    return run;
  };

  /** True when `text` is exactly what this writer last wrote (lets a file watcher ignore our own writes). */
  isOwnWrite(text: string): boolean {
    return this.lastHash !== null && sha256(text) === this.lastHash;
  }

  status(): ConfigWriteBackStatus {
    return { path: this.opts.path, ...this.state, skipped: [...this.skipped] };
  }

  cards(): AttentionCard[] {
    const now = this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    const name = basename(this.opts.path);
    const cards: AttentionCard[] = [];
    const err = this.state.error;
    if (err) {
      cards.push({
        id: 'runtime.config-writeback',
        relayId: null,
        severity: 'warning',
        title: `${name} is not being updated`,
        body: `Changes made in the app are saved in the database but can't be written to ${name}. They still work, but the file is out of date.`,
        technical: `GitOps write-back to ${this.opts.path} failed: ${err.code} (${err.message}). Make the file and its directory writable, or start with --no-config-writeback (BEAMHOP_CONFIG_WRITEBACK=false) to turn write-back off.`,
        batchKey: 'runtime.config-writeback',
        createdAt: now,
      });
    }
    if (this.skipped.size > 0) {
      cards.push({
        id: 'runtime.config-writeback.overrides',
        relayId: null,
        severity: 'info',
        title: 'Some changed settings come from environment variables',
        body: `These changes were saved in the app but not in ${name}, because the server gets them from its environment. Update the environment too, or they go back to the old values after a restart.`,
        technical: `Not written to ${this.opts.path} (set by BEAMHOP_* env vars, command-line flags or \${VAR} references): ${[...this.skipped].join(', ')}`,
        batchKey: 'runtime.config-writeback',
        createdAt: now,
      });
    }
    return cards;
  }

  private async apply(yaml: string): Promise<void> {
    const next = normalize(YAML.parse(yaml)) as unknown;
    const ops = configDiff(this.baseline, next);
    if (ops.length === 0) {
      this.baseline = next;
      return;
    }
    const overrides = this.opts.overridePaths ?? [];
    let target = this.opts.path;
    try {
      try {
        target = realpathSync(this.opts.path);
      } catch {
        // Missing file: reported by the access check below.
      }
      accessSync(target, constants.R_OK | constants.W_OK);
      const st = statSync(target);
      const text = readFileSync(target, 'utf8');
      const doc = YAML.parseDocument(text);
      if (doc.errors.length > 0) {
        throw Object.assign(new Error(`the file has a YAML error: ${doc.errors[0]?.message}`), {
          code: 'EPARSE',
        });
      }
      const skipped: string[] = [];
      for (const op of ops) {
        if (overrides.some((o) => startsWith(op.path, o) || startsWith(o, op.path))) {
          skipped.push(pathText(op.path));
          continue;
        }
        if (hasReference(doc, op.path)) {
          skipped.push(pathText(op.path));
          continue;
        }
        if (op.value === undefined) deleteIn(doc, op.path);
        else setIn(doc, op.path, next);
      }
      const out = String(doc);
      if (out !== text) atomicWrite(target, out, st);
      this.lastHash = sha256(out);
      for (const s of skipped) this.skipped.add(s);
      this.baseline = next;
      if (this.state.error)
        this.opts.logger.log('info', 'settings file is being updated again', {
          file: this.opts.path,
        });
      this.state = { lastWriteAt: this.opts.now?.() ?? Math.floor(Date.now() / 1000) };
      this.loggedCodes.clear();
    } catch (err) {
      // Keep the old baseline so the next successful write includes these changes too.
      const code = errCode(err);
      const message = err instanceof Error ? err.message : String(err);
      this.state = { ...this.state, error: { code, message } };
      if (!this.loggedCodes.has(code)) {
        this.loggedCodes.add(code);
        this.opts.logger.log(
          'warn',
          'settings changed in the app could not be written to the settings file',
          { file: this.opts.path, code },
        );
      }
    }
  }
}

function atomicWrite(target: string, text: string, st: Stats): void {
  const mode = Number(st.mode) & 0o7777;
  const tmp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const fd = openSync(tmp, 'wx', mode);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode); // umask may have narrowed it
    try {
      chownSync(tmp, Number(st.uid), Number(st.gid));
    } catch {
      // Not root: the file keeps our owner.
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

/** Loose view of `admin.config` used here. */
interface WritableConfigService {
  setFileWriter?(fn: ((yaml: string) => Promise<void>) | null): void;
}

/**
 * Hook `admin.config` write-back to `opts.path`. Call after the boot file was adopted
 * (the kernel's current config is the baseline). Returns null without a config service.
 */
export function installConfigWriteBack(
  kernel: Kernel,
  opts: Omit<ConfigWriteBackOptions, 'now'> & { now?: () => number },
): ConfigFileWriter | null {
  const svc = kernel.use<WritableConfigService>('admin.config');
  if (!svc?.setFileWriter) return null;
  const writer = new ConfigFileWriter(
    { now: () => kernel.ports.clock.now(), ...opts },
    kernel.config(),
  );
  svc.setFileWriter(writer.write);
  kernel.provide(CONFIG_FILE_SERVICE, writer);
  kernel.cards.push({ id: 'runtime.config-writeback', cards: async () => writer.cards() });
  return writer;
}
