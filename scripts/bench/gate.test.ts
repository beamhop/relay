// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILES,
  type Thresholds,
  effectiveThresholds,
  evaluate,
  parseFanout,
  parseStorage,
} from './gate.ts';
import { parseLoadArgs } from './load.ts';

const file: Thresholds = {
  _comment: {},
  load: { accepted_eps: { min: 450 }, ok_p95_ms: { max: 250 }, _note: {} },
  verify: { pool_eps: { min: 1000 } },
};

describe('bench gate', () => {
  test('applies file thresholds and skips comment keys', () => {
    const th = effectiveThresholds(file, {});
    expect(Object.keys(th)).toEqual(['load', 'verify']);
    expect(th.load).toEqual({ accepted_eps: { min: 450 }, ok_p95_ms: { max: 250 } });
  });

  test('env overrides one bound; BENCH_SCALE tightens the rest', () => {
    const th = effectiveThresholds(file, {
      BENCH_LOAD_ACCEPTED_EPS_MIN: '900',
      BENCH_SCALE: '2',
    });
    expect(th.load!.accepted_eps).toEqual({ min: 900 });
    expect(th.load!.ok_p95_ms).toEqual({ max: 125 });
    expect(th.verify!.pool_eps).toEqual({ min: 2000 });
  });

  test('fails below a floor, above a ceiling, and on missing metrics', () => {
    const th = effectiveThresholds(file, {});
    const checks = evaluate(th, {
      load: { accepted_eps: 449, ok_p95_ms: 12 },
      verify: { pool_eps: null },
    });
    expect(checks.map((c) => [c.metric, c.ok])).toEqual([
      ['accepted_eps', false],
      ['ok_p95_ms', true],
      ['pool_eps', false],
    ]);
    // Benches that were not run (--only) are not checked.
    expect(evaluate(th, { load: { accepted_eps: 500, ok_p95_ms: 300 } }).map((c) => c.ok)).toEqual([
      true,
      false,
    ]);
  });

  test('parses the text output of the storage and fan-out benches', () => {
    expect(
      parseStorage(
        [
          'ingest: 30000 events in 2.10s = 14285 events/s (/tmp/x.sqlite)',
          'ingest (sequential awaits): 3100 events/s',
          'query author feed 50 authors       0.420 ms  (2380 q/s)',
          'query #p mentions (limit 50)       0.080 ms  (12500 q/s)',
        ].join('\n'),
      ),
    ).toEqual({
      ingest_eps: 14285,
      ingest_sequential_eps: 3100,
      query_author_feed_ms: 0.42,
      query_mentions_ms: 0.08,
    });
    expect(
      parseFanout(
        [
          'subscriptions: 10000 over 1000 connections',
          'broadcast: 65,432 events/s, 123,456 frames/s (1,000 deliveries)',
          'ingest (verify+store+fan-out): 3,210 events/s',
        ].join('\n'),
      ),
    ).toEqual({ broadcast_eps: 65432, broadcast_frames_per_s: 123456, ingest_eps: 3210 });
  });

  test('committed thresholds cover every metric the gate produces and the CI profile parses', () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dir, 'thresholds.json'), 'utf8'),
    ) as Thresholds;
    const th = effectiveThresholds(committed, {});
    expect(Object.keys(th).sort()).toEqual(['fanout', 'load', 'storage', 'verify']);
    for (const bounds of Object.values(th))
      for (const b of Object.values(bounds)) expect(b.min ?? b.max).toBeNumber();
    const o = parseLoadArgs(PROFILES.ci!.load);
    expect(o.conns).toBe(1000);
    expect(o.rate).toBe(400);
  });
});
