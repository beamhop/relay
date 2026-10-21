// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "a3f9…7c21" for long hex keys and hashes. */
export function short(id: string | undefined | null, n = 6): string {
  if (!id) return '';
  return id.length > n * 2 + 1 ? `${id.slice(0, n)}…${id.slice(-4)}` : id;
}

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${n < 0 ? '-' : ''}${v >= 10 || i === 0 ? Math.round(v) : String(Number(v.toFixed(1)))} ${units[i]}`;
}

/** "2h ago" style relative time for Unix seconds or ms. */
export function ago(t: number, now = Date.now()): string {
  const ms = t < 1e12 ? t * 1000 : t;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function isDesktop(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(min-width: 768px)').matches;
}
