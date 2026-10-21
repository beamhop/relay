// SPDX-License-Identifier: AGPL-3.0-or-later
/** Media screen helpers: tier bars, fill levels, "in 3h", file lens lines, abuse never shown. */
import { describe, expect, it } from 'vitest';
import {
  canShowImage,
  fileLensLines,
  tierLevel,
  tierQuota,
  until,
} from '../src/lib/components/media/media.ts';

describe('media helpers', () => {
  it('turns a tier into QuotaBar numbers only when there is a cap and a count', () => {
    expect(tierQuota({ usedBytes: 85, maxBytes: 100 })).toEqual({
      used: 85,
      quota: 100,
      left: 15,
      over: false,
      fraction: 0.85,
    });
    expect(tierQuota({ usedBytes: 120, maxBytes: 100 })).toMatchObject({
      over: true,
      left: 0,
      fraction: 1,
    });
    expect(tierQuota({ usedBytes: 5, maxBytes: null })).toBeNull();
    expect(tierQuota({ usedBytes: null, maxBytes: 100 })).toBeNull();
  });

  it('uses the server thresholds (80% warn, 95% critical)', () => {
    expect(tierLevel(null)).toBe('ok');
    expect(tierLevel(0.79)).toBe('ok');
    expect(tierLevel(0.8)).toBe('warn');
    expect(tierLevel(0.95)).toBe('critical');
  });

  it('formats future times', () => {
    const now = 1_700_000_000_000;
    const t = now / 1000;
    expect(until(t + 30, now)).toBeNull();
    expect(until(t + 300, now)).toBe('5m');
    expect(until(t + 3 * 3600, now)).toBe('3h');
    expect(until(t + 2 * 86400, now)).toBe('2d');
  });

  it('lists sha256, mime, tier and owners in the lens', () => {
    expect(
      fileLensLines({
        sha256: 'ab',
        pubkey: 'p',
        size: 1,
        type: 'image/png',
        tier: 'cold',
        owners: 2,
      }),
    ).toEqual([
      'sha256 ab',
      'mime image/png',
      'tier cold',
      'owners 2 (BlobIndex rows on this relay)',
    ]);
    expect(fileLensLines({ sha256: 'ab', pubkey: 'p', size: 1 })).toEqual([
      'sha256 ab',
      'mime unknown',
      'tier hot',
    ]);
  });

  it('never shows abuse-list matches', () => {
    expect(canShowImage({ abuse: true, previewable: true })).toBe(false);
    expect(canShowImage({ abuse: false, previewable: true })).toBe(true);
    expect(canShowImage({ abuse: false, previewable: false })).toBe(false);
  });
});
