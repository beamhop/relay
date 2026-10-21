// SPDX-License-Identifier: AGPL-3.0-or-later
/** Human-readable report, JSON report and the SVG badge. */
import type { CheckResult, Report } from './types.ts';

const COLORS = {
  pass: '\x1b[32m',
  fail: '\x1b[31m',
  skip: '\x1b[33m',
  dim: '\x1b[2m',
  off: '\x1b[0m',
};

export function formatResult(r: CheckResult, color = false): string {
  const label = r.status.toUpperCase().padEnd(4);
  const tag = color ? `${COLORS[r.status]}${label}${COLORS.off}` : label;
  const spec = r.spec.padEnd(9);
  const msg = color ? `${COLORS.dim}${r.message}${COLORS.off}` : r.message;
  return `${tag} ${spec} ${r.title}\n     ${' '.repeat(9)} ${msg}`;
}

export function formatReport(report: Report, color = false): string {
  const lines: string[] = [];
  lines.push(`Conformance report for ${report.target.relay}`);
  if (report.target.blossom) lines.push(`Media server: ${report.target.blossom}`);
  if (report.software)
    lines.push(`Software: ${report.software}${report.version ? ` ${report.version}` : ''}`);
  lines.push(
    `Advertised NIPs: ${report.supportedNips.length ? report.supportedNips.join(', ') : '(none)'}`,
  );
  lines.push('');
  for (const r of report.results) lines.push(formatResult(r, color));
  lines.push('');
  lines.push(summaryLine(report));
  return lines.join('\n');
}

export function summaryLine(report: Report): string {
  const s = report.summary;
  return `${s.pass} passed, ${s.fail} failed, ${s.skip} skipped (${(report.durationMs / 1000).toFixed(1)} s)`;
}

export function toJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Pass ratio over checks that ran (skips excluded). */
export function passRatio(report: Report): number {
  const ran = report.summary.pass + report.summary.fail;
  return ran === 0 ? 0 : report.summary.pass / ran;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Approximate text width for Verdana 11px (shields.io style). */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[il.:,|!']/.test(ch) ? 3.5 : /[mwMW%]/.test(ch) ? 10 : 7;
  return Math.ceil(w);
}

/** Flat badge: "nostr conformance | 41/43". */
export function badgeSvg(report: Report, label = 'nostr conformance'): string {
  const ran = report.summary.pass + report.summary.fail;
  const value = ran === 0 ? 'n/a' : `${report.summary.pass}/${ran}`;
  const ratio = passRatio(report);
  const color =
    ran === 0
      ? '#9f9f9f'
      : ratio === 1
        ? '#4c1'
        : ratio >= 0.9
          ? '#97ca00'
          : ratio >= 0.75
            ? '#dfb317'
            : ratio >= 0.5
              ? '#fe7d37'
              : '#e05d44';
  const lw = textWidth(label) + 12;
  const vw = textWidth(value) + 12;
  const w = lw + vw;
  const l = escapeXml(label);
  const v = escapeXml(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${v}">
<title>${l}: ${v}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${l}</text><text x="${lw / 2}" y="14">${l}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${v}</text><text x="${lw + vw / 2}" y="14">${v}</text>
</g>
</svg>
`;
}
