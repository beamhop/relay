// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs the full conformance suite (plus a short fuzz run) against Beamhop's
 * relay + policy + blossom modules in-process, with memory storage.
 */
import { describe, expect, test } from 'bun:test';
import { formatReport, runSuite } from '../src/index.ts';
import { inProcessHarness } from './helpers.ts';

describe('conformance suite against Beamhop (in-process)', () => {
  test('all advertised NIPs and BUDs pass', async () => {
    const { target } = await inProcessHarness();
    const report = await runSuite({
      relayUrl: target.relayUrl,
      blossomUrl: target.blossomUrl,
      dial: target.dial,
      fetch: target.fetch,
      allowPrivateMirror: true,
      timeoutMs: 3000,
      fuzz: 120,
      seed: 1234,
    });
    const failed = report.results.filter((r) => r.status === 'fail');
    if (failed.length) console.log(formatReport(report));
    expect(failed.map((r) => `${r.id}: ${r.message}`)).toEqual([]);
    expect(report.summary.pass).toBeGreaterThan(30);
    // Fuzz results are part of the report.
    expect(report.results.find((r) => r.id === 'fuzz.liveness')?.status).toBe('pass');
  }, 60_000);
});
