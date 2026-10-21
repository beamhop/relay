// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { nativeTarget, parseSmokeArgs } from '../smoke/linux.ts';

describe('smoke/linux.ts', () => {
  test('microVMs run the host architecture', () => {
    expect(nativeTarget('arm64')).toBe('linux-arm64');
    expect(nativeTarget('x64')).toBe('linux-x64');
  });

  test('arguments', () => {
    const a = parseSmokeArgs(['--dist', '/d', '--target', 'linux-arm64,linux-x64', '--keep']);
    expect(a.dist).toBe('/d');
    expect(a.targets).toEqual(['linux-arm64', 'linux-x64']);
    expect(a.keep).toBe(true);
    expect(parseSmokeArgs([]).targets).toEqual([nativeTarget()]);
    expect(() => parseSmokeArgs(['--nope'])).toThrow('unknown option');
  });
});
