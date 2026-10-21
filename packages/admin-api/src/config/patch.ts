// SPDX-License-Identifier: AGPL-3.0-or-later
/** RFC 6902 JSON Patch (apply + diff) and RFC 7396 JSON Merge Patch. */
import { clone, deepEqual, isSecretKey, redact } from '../util.ts';

/** Mask secret values in patch ops (by the last path segment, and nested secret keys). */
export function redactPatch(ops: JsonPatchOp[]): JsonPatchOp[] {
  return ops.map((op) => {
    if (!('value' in op)) return op;
    const last = parsePointer(op.path).at(-1) ?? '';
    return { ...op, value: isSecretKey(last) && op.value != null ? '•••' : redact(op.value) };
  });
}

export type JsonPatchOp =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; from: string; path: string };

export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`invalid JSON pointer: ${path}`);
  return path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function toPointer(parts: Array<string | number>): string {
  return parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

type Container = Record<string, unknown> | unknown[];

function walk(doc: unknown, parts: string[]): { parent: Container; key: string } {
  let cur: unknown = doc;
  for (const p of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object')
      throw new Error(`path not found: /${parts.join('/')}`);
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  if (cur === null || typeof cur !== 'object')
    throw new Error(`path not found: /${parts.join('/')}`);
  return { parent: cur as Container, key: parts[parts.length - 1] as string };
}

function getAt(doc: unknown, parts: string[]): unknown {
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object')
      throw new Error(`path not found: /${parts.join('/')}`);
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length)
        throw new Error(`path not found: /${parts.join('/')}`);
      cur = cur[i];
    } else {
      if (!Object.hasOwn(cur, p)) throw new Error(`path not found: /${parts.join('/')}`);
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}

function arrayIndex(arr: unknown[], key: string, forAdd: boolean): number {
  if (forAdd && key === '-') return arr.length;
  const i = Number(key);
  const max = forAdd ? arr.length : arr.length - 1;
  if (!/^\d+$/.test(key) || i > max) throw new Error(`bad array index: ${key}`);
  return i;
}

function addAt(doc: unknown, parts: string[], value: unknown): unknown {
  if (parts.length === 0) return value;
  const { parent, key } = walk(doc, parts);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, true), 0, value);
  else parent[key] = value;
  return doc;
}

function removeAt(doc: unknown, parts: string[]): unknown {
  if (parts.length === 0) throw new Error('cannot remove the whole document');
  getAt(doc, parts);
  const { parent, key } = walk(doc, parts);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, false), 1);
  else delete parent[key];
  return doc;
}

/** Apply a JSON Patch; returns a new document (input is not mutated). Throws on failure. */
export function applyPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  let out: unknown = clone(doc);
  for (const op of ops) {
    const parts = parsePointer(op.path);
    switch (op.op) {
      case 'add':
        out = addAt(out, parts, clone(op.value));
        break;
      case 'remove':
        out = removeAt(out, parts);
        break;
      case 'replace':
        if (parts.length === 0) out = clone(op.value);
        else {
          getAt(out, parts);
          out = removeAt(out, parts);
          out = addAt(out, parts, clone(op.value));
        }
        break;
      case 'test':
        if (!deepEqual(getAt(out, parts), op.value)) throw new Error(`test failed at ${op.path}`);
        break;
      case 'move': {
        const from = parsePointer(op.from);
        const v = getAt(out, from);
        out = removeAt(out, from);
        out = addAt(out, parts, v);
        break;
      }
      case 'copy':
        out = addAt(out, parts, clone(getAt(out, parsePointer(op.from))));
        break;
      default:
        throw new Error(`unknown op: ${(op as { op: string }).op}`);
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

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const idsOf = (arr: unknown[]): string[] | null => {
  const ids = arr.map((x) => (isObj(x) && typeof x.id === 'string' ? x.id : null));
  return ids.every((x) => x !== null) ? (ids as string[]) : null;
};

/**
 * Minimal JSON Patch turning `a` into `b`. Arrays of id-keyed objects with the
 * same id order are diffed element-wise; other array changes replace the array.
 */
export function diffPatch(
  a: unknown,
  b: unknown,
  base: Array<string | number> = [],
): JsonPatchOp[] {
  if (deepEqual(a, b)) return [];
  if (isObj(a) && isObj(b)) {
    const ops: JsonPatchOp[] = [];
    for (const k of Object.keys(a))
      if (!(k in b) || b[k] === undefined) {
        if (a[k] !== undefined) ops.push({ op: 'remove', path: toPointer([...base, k]) });
      }
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (!(k in a) || a[k] === undefined)
        ops.push({ op: 'add', path: toPointer([...base, k]), value: clone(v) });
      else ops.push(...diffPatch(a[k], v, [...base, k]));
    }
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const ia = idsOf(a);
    const ib = idsOf(b);
    if (ia && ib && ia.join('\u0000') === ib.join('\u0000')) {
      return a.flatMap((x, i) => diffPatch(x, b[i], [...base, i]));
    }
  }
  return [{ op: 'replace', path: toPointer(base), value: clone(b) }];
}
