// SPDX-License-Identifier: AGPL-3.0-or-later
/** Home tile sparklines are plain SVG paths (no chart library on first load). */
import { describe, expect, it } from 'vitest';
import { sparkPaths } from '../src/lib/sparkline.ts';

describe('sparkline', () => {
  it('needs at least two points', () => {
    expect(sparkPaths([])).toEqual({ line: '', area: '' });
    expect(sparkPaths([5])).toEqual({ line: '', area: '' });
  });

  it('spans the box with the floor at zero', () => {
    const { line, area } = sparkPaths([0, 10], 100, 32, 0);
    expect(line).toBe('M0,32L100,0');
    expect(area).toBe('M0,32L100,0L100,32L0,32Z');
  });

  it('handles flat and non-finite series', () => {
    expect(sparkPaths([3, 3, 3], 100, 32, 0).line).toBe('M0,0L50,0L100,0');
    expect(sparkPaths([1, Number.NaN, 2], 10, 10, 0).line).toBe('M0,5L10,0');
  });
});
