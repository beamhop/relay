// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { LOG_FORMAT, checkCommit, checkCommits, parseLog, signOffs } from './dco-check.ts';

const F = '\x1f';
const R = '\x1e';
const record = (sha: string, name: string, email: string, body: string) =>
  `${sha}${F}${name}${F}${email}${F}${body}${R}\n`;

describe('dco-check', () => {
  test('log format uses field and record separators', () => {
    expect(LOG_FORMAT).toBe('%H\x1f%an\x1f%ae\x1f%B\x1e');
  });

  test('parses git log records, including multi-line bodies', () => {
    const raw =
      record(
        'a1',
        'Ada',
        'ada@example.com',
        'feat: x\n\nBody line\n\nSigned-off-by: Ada <ada@example.com>\n',
      ) + record('b2', 'Bob', 'bob@example.com', 'fix: y\n');
    const commits = parseLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'a1',
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      message: 'feat: x\n\nBody line\n\nSigned-off-by: Ada <ada@example.com>',
    });
    expect(commits[1]?.sha).toBe('b2');
    expect(parseLog('')).toEqual([]);
  });

  test('reads every Signed-off-by trailer', () => {
    expect(
      signOffs(
        'x\n\nCo-Authored-By: C <c@x>\nSigned-off-by: Ada L <ada@example.com>\nsigned-off-by: Bob <bob@x.org>',
      ),
    ).toEqual([
      { name: 'Ada L', email: 'ada@example.com' },
      { name: 'Bob', email: 'bob@x.org' },
    ]);
    // Mentions in prose are not trailers.
    expect(signOffs('Remember to add Signed-off-by lines')).toEqual([]);
  });

  test('accepts a sign-off matching the author email (case-insensitive)', () => {
    const c = {
      sha: 'a',
      authorName: 'Ada',
      authorEmail: 'Ada@Example.com',
      message: 'feat\n\nSigned-off-by: Ada <ada@example.com>',
    };
    expect(checkCommit(c)).toBeNull();
  });

  test('rejects a missing or mismatched sign-off', () => {
    const missing = { sha: 'a', authorName: 'Ada', authorEmail: 'ada@x', message: 'feat: x' };
    expect(checkCommit(missing)?.reason).toBe('no Signed-off-by line');
    const other = {
      sha: 'b',
      authorName: 'Ada',
      authorEmail: 'ada@x',
      message: 'feat: y\n\nSigned-off-by: Bob <bob@x>',
    };
    expect(checkCommit(other)?.reason).toContain('does not match the author Ada <ada@x>');
    expect(checkCommits([missing, other]).map((p) => p.subject)).toEqual(['feat: x', 'feat: y']);
  });

  test('skips GitHub bot commits', () => {
    const bot = {
      sha: 'c',
      authorName: 'dependabot[bot]',
      authorEmail: '49699333+dependabot[bot]@users.noreply.github.com',
      message: 'chore(deps): bump',
    };
    expect(checkCommit(bot)).toBeNull();
  });
});
