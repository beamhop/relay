// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal RFC 6902 JSON Patch + RFC 7396 merge patch, with the same input
 * shape as the admin-api config proposal. Kept local (instead of importing
 * admin-api) so the sandbox works whether or not admin-api is enabled.
 */
export type JsonPatchOp =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; from: string; path: string };

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`invalid JSON pointer: ${path}`);
  return path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

type Container = Record<string, unknown> | unknown[];

function parentOf(root: unknown, parts: string[]): { parent: Container; key: string } {
  let cur = root;
  for (const p of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') throw new Error(`path not found at ${p}`);
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  if (cur === null || typeof cur !== 'object') throw new Error('path not found');
  return { parent: cur as Container, key: parts[parts.length - 1] ?? '' };
}

function getAt(root: unknown, parts: string[]): unknown {
  let cur = root;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') throw new Error(`path not found at ${p}`);
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function addAt(root: unknown, parts: string[], value: unknown, replace: boolean): unknown {
  if (parts.length === 0) return clone(value);
  const { parent, key } = parentOf(root, parts);
  if (Array.isArray(parent)) {
    const i = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(i) || i < 0 || i > parent.length) throw new Error(`bad index ${key}`);
    if (replace) parent[i] = clone(value);
    else parent.splice(i, 0, clone(value));
  } else {
    if (replace && !(key in parent)) throw new Error(`nothing to replace at ${key}`);
    parent[key] = clone(value);
  }
  return root;
}

function removeAt(root: unknown, parts: string[]): unknown {
  const { parent, key } = parentOf(root, parts);
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else {
    if (!(key in parent)) throw new Error(`nothing to remove at ${key}`);
    delete parent[key];
  }
  return root;
}

export function applyPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  let out: unknown = clone(doc);
  for (const op of ops) {
    const parts = parsePointer(op.path);
    switch (op.op) {
      case 'add':
        out = addAt(out, parts, op.value, false);
        break;
      case 'replace':
        out = addAt(out, parts, op.value, true);
        break;
      case 'remove':
        out = removeAt(out, parts);
        break;
      case 'test':
        if (JSON.stringify(getAt(out, parts)) !== JSON.stringify(op.value))
          throw new Error(`test failed at ${op.path}`);
        break;
      case 'copy':
        out = addAt(out, parts, getAt(out, parsePointer(op.from)), false);
        break;
      case 'move': {
        const from = parsePointer(op.from);
        const v = getAt(out, from);
        out = addAt(removeAt(out, from), parts, v, false);
        break;
      }
    }
  }
  return out as T;
}

/** RFC 7396 merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
