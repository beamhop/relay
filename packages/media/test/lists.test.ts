// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { HashListCache, loadListText, matchHashes, parseHashList } from '../src/lists.ts';
import { stubFetch } from './helpers.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'test-hashes.txt');

describe('hash lists', () => {
  test('parses hashes, prefixes, comments and labels', () => {
    const { entries, invalid } = parseHashList(
      '# comment\n\nABCDEF0123456789 label\ndhash:0000000000000001\nphash:ffffffffffffffff, x\nbad\n123',
    );
    expect(entries.map((e) => `${e.algo}:${e.hash}`)).toEqual([
      'phash:abcdef0123456789',
      'dhash:0000000000000001',
      'phash:ffffffffffffffff',
    ]);
    expect(invalid).toBe(2);
  });

  test('matches within the Hamming threshold, per algorithm', () => {
    const list = {
      source: 's',
      ...parseHashList('00000000000000ff\ndhash:ffff000000000000'),
      loadedAt: 0,
    };
    expect(matchHashes({ phash: '00000000000000ff' }, [list], 0)?.distance).toBe(0);
    expect(matchHashes({ phash: '00000000000000f0' }, [list], 4)?.distance).toBe(4);
    expect(matchHashes({ phash: '00000000000000f0' }, [list], 3)).toBeNull();
    // dhash entries are not compared with phash values
    expect(matchHashes({ phash: 'ffff000000000000' }, [list], 0)).toBeNull();
    expect(matchHashes({ dhash: 'ffff000000000001' }, [list], 2)).toMatchObject({
      algo: 'dhash',
      distance: 1,
      source: 's',
    });
  });

  test('loads the local fixture file and URLs via injected fetch', async () => {
    const local = parseHashList(await loadListText(FIXTURE));
    expect(local.entries).toHaveLength(2);
    expect(local.invalid).toBe(1);
    const text = await loadListText('https://lists.example/a.txt', {
      fetch: stubFetch({ 'https://lists.example/a.txt': '0123456789abcdef' }),
    });
    expect(text).toBe('0123456789abcdef');
    await expect(
      loadListText('https://lists.example/missing', { fetch: stubFetch({}) }),
    ).rejects.toThrow('HTTP 404');
  });

  test('cache keeps the previous entries when a reload fails', async () => {
    const data: Record<string, string | number> = { 'https://l.example/x': '0123456789abcdef' };
    const cache = new HashListCache({ fetch: stubFetch(data), now: () => 1 });
    const [first] = await cache.get(['https://l.example/x']);
    expect(first?.entries).toHaveLength(1);
    data['https://l.example/x'] = 500;
    await cache.refresh(['https://l.example/x']);
    const [after] = cache.status();
    expect(after?.error).toBe('HTTP 500');
    expect(after?.entries).toHaveLength(1);
    await cache.refresh([]);
    expect(cache.status()).toHaveLength(0);
  });
});
