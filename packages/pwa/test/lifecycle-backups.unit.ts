// SPDX-License-Identifier: AGPL-3.0-or-later
/** Backups and restore screen (vanilla lazy chunk): pure helpers behind the list. */
import { describe, expect, it } from 'vitest';
import {
  type BackupRow,
  checkState,
  health,
  lensLines,
  sorted,
} from '../src/lib/modules/lifecycle-backups/backups';

const row = (o: Partial<BackupRow> = {}): BackupRow => ({
  id: 'b-1',
  at: 1_760_000_000,
  ok: true,
  trigger: 'scheduled',
  sha256: 'a'.repeat(64),
  size: 12 * 1024 * 1024,
  location: 'fs:data/backups',
  dbFormat: 'sqlite',
  driver: 'sqlite',
  events: 1200,
  blobs: 30,
  durationMs: 420,
  ...o,
});

describe('backups list helpers', () => {
  it('tells checked, damaged and not-yet-checked backups apart', () => {
    expect(checkState(row())).toBe('unchecked');
    expect(checkState(row({ verifiedAt: 5, verifiedOk: true }))).toBe('ok');
    expect(checkState(row({ verifiedAt: 5, verifiedOk: false }))).toBe('bad');
  });

  it('overall state: off, never, failed, ok', () => {
    expect(health({ target: null, last: null, backups: [] })).toBe('off');
    expect(health({ target: 'fs:data/backups', last: null, backups: [] })).toBe('never');
    expect(
      health({ target: 'fs:x', last: { at: 1, ok: false, error: 'disk full' }, backups: [row()] }),
    ).toBe('failed');
    expect(health({ target: 'fs:x', last: { at: 1, ok: true }, backups: [row()] })).toBe('ok');
    // Backups made earlier stay listed even when the storage setting was removed.
    expect(health({ target: null, last: null, backups: [row()] })).toBe('ok');
  });

  it('keeps technical details for the lens and sorts newest first', () => {
    const lines = lensLines(row({ encrypted: true, verifiedAt: 9, verifiedOk: true, docs: 4 }));
    expect(lines[0]).toBe('id b-1');
    expect(lines.join(' ')).toContain('1200 events · 30 blobs · 4 docs');
    expect(lines.join(' ')).toContain('sealed with the key service');
    expect(lines.join(' ')).toContain('verified ok');
    const list = [row({ id: 'old', at: 1 }), row({ id: 'new', at: 3 }), row({ id: 'mid', at: 2 })];
    expect(sorted(list).map((b) => b.id)).toEqual(['new', 'mid', 'old']);
    expect(list[0]?.id).toBe('old');
  });
});
