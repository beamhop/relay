// SPDX-License-Identifier: AGPL-3.0-or-later
/** Plain-language rendering helpers shared by commands. */
import { type Io, paint } from './io.ts';

export interface DiffLine {
  text: string;
  technical?: string;
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
}

const MARK: Record<DiffLine['kind'], string> = {
  add: '+',
  remove: '-',
  change: '~',
  info: '•',
  warning: '!',
};

export function renderDiff(io: Io, diff: DiffLine[], technical: boolean): string {
  const p = paint(io);
  const color: Record<DiffLine['kind'], (s: string) => string> = {
    add: p.green,
    remove: p.red,
    change: p.yellow,
    info: (s) => s,
    warning: p.yellow,
  };
  if (!diff.length) return `  ${p.dim('(nothing would change)')}\n`;
  return diff
    .map((d) => {
      const head = `  ${color[d.kind](MARK[d.kind] ?? '•')} ${d.text}`;
      return technical && d.technical ? `${head}\n    ${p.dim(d.technical)}` : head;
    })
    .join('\n')
    .concat('\n');
}

const isScalar = (v: unknown) => v === null || typeof v !== 'object';

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Readable, YAML-ish rendering of an action's output. */
export function renderValue(v: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (isScalar(v)) return `${pad}${scalar(v)}`;
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}(none)`;
    return v
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}`;
        const inner = renderValue(item, indent + 2).trimStart();
        return `${pad}- ${inner}`;
      })
      .join('\n');
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (!entries.length) return `${pad}(empty)`;
  return entries
    .map(([k, x]) => {
      if (isScalar(x) || (Array.isArray(x) && x.every(isScalar) && x.length <= 8))
        return `${pad}${k}: ${Array.isArray(x) ? (x.length ? x.map(scalar).join(', ') : '(none)') : scalar(x)}`;
      return `${pad}${k}:\n${renderValue(x, indent + 2)}`;
    })
    .join('\n');
}

export function json(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

export function when(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
