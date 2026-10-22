import { format, formatDistanceToNowStrict } from "date-fns";

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

const nf = new Intl.NumberFormat();
const cf = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const formatNumber = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : nf.format(n));
export const formatCompact = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : cf.format(n));
export const formatRate = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n >= 100 ? cf.format(Math.round(n)) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, "") || "0";
export const formatPercent = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`);
export const formatMs = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(n < 10 ? 1 : 0)} ms`;

/** unix seconds → "3m ago" */
export function timeAgo(sec: number | null | undefined): string {
  if (!sec) return "never";
  return formatDistanceToNowStrict(new Date(sec * 1000), { addSuffix: true });
}
export function formatDate(sec: number | null | undefined, pattern = "PP p"): string {
  if (!sec) return "—";
  return format(new Date(sec * 1000), pattern);
}
export function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}
export const nowSec = () => Math.floor(Date.now() / 1000);

export function countryFlag(cc: string | undefined): string {
  if (!cc || cc.length !== 2) return "🏳️";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
