// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tiny sparkline geometry for the Home tiles: an inline SVG path, no chart
 * library (LayerChart/d3 load only for the detail chart).
 */

export interface SparkPaths {
  /** Polyline through the points. */
  line: string;
  /** Closed area under the line, down to y = height. */
  area: string;
}

const r = (n: number) => Math.round(n * 100) / 100;

/** Paths for `points` in a `width`×`height` box (y = 0 at the bottom of the data range, floor 0). */
export function sparkPaths(points: number[], width = 100, height = 32, pad = 1.5): SparkPaths {
  const xs = points.filter((p) => Number.isFinite(p));
  if (xs.length < 2) return { line: '', area: '' };
  const max = Math.max(0, ...xs);
  const min = Math.min(0, ...xs);
  const span = max - min || 1;
  const step = width / (xs.length - 1);
  const y = (v: number) => r(pad + (height - 2 * pad) * (1 - (v - min) / span));
  const coords = xs.map((v, i) => `${r(i * step)},${y(v)}`);
  const line = `M${coords.join('L')}`;
  const area = `${line}L${r(width)},${height}L0,${height}Z`;
  return { line, area };
}
