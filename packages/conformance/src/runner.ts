// SPDX-License-Identifier: AGPL-3.0-or-later
/** Runs the checks against a relay (and optionally a Blossom server). */
import { blossomChecks } from './checks/blossom.ts';
import { nip01Checks } from './checks/nip01.ts';
import { nipChecks } from './checks/nips.ts';
import { type Dialer, RelayClient, webSocketDialer } from './client.ts';
import { runFuzz } from './fuzz.ts';
import {
  type Check,
  CheckFailure,
  type CheckResult,
  CheckSkip,
  type RelayInfo,
  type Report,
  type SuiteContext,
  newKey,
  signEvent,
} from './types.ts';

export const ALL_CHECKS: Check[] = [...nip01Checks, ...nipChecks, ...blossomChecks];

export interface RunOptions {
  relayUrl: string;
  blossomUrl?: string;
  /** Only run checks for these NIPs (e.g. [1, 11, 42]). */
  nips?: number[];
  /** Only run these BUDs (e.g. [1, 2]); default all when `blossomUrl` is set. */
  buds?: number[];
  /** Only run checks whose id starts with one of these. */
  only?: string[];
  /** Per-message timeout (ms). Default 5000. */
  timeoutMs?: number;
  /** Number of fuzz frames; 0/undefined disables fuzzing. */
  fuzz?: number;
  seed?: number;
  dial?: Dialer;
  fetch?: SuiteContext['fetch'];
  allowPrivateMirror?: boolean;
  /** Also run checks for NIPs the relay does not advertise (to find gaps). */
  all?: boolean;
  onResult?: (r: CheckResult) => void;
}

export function httpUrlOf(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//i, 'http$1://');
}

/** Numbers named by a spec label: "NIP-17/59" → [17, 59], "BUD-02" → [2]. */
export function specNumbers(spec: string): number[] {
  const m = /^(?:NIP|BUD)-(.+)$/.exec(spec);
  return m ? m[1]!.split('/').map((n) => Number.parseInt(n, 10)) : [];
}

export async function fetchRelayInfo(
  httpUrl: string,
  doFetch: SuiteContext['fetch'],
  timeoutMs: number,
): Promise<RelayInfo | null> {
  try {
    const res = await doFetch(httpUrl, {
      headers: { accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const doc = (await res.json()) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as RelayInfo) : null;
  } catch {
    return null;
  }
}

function selected(c: Check, o: RunOptions): boolean {
  if (o.only?.length && !o.only.some((p) => c.id.startsWith(p))) return false;
  const nums = specNumbers(c.spec);
  if (c.blossom) {
    if (o.buds?.length) return nums.some((n) => o.buds!.includes(n));
    return !o.nips?.length || !!o.blossomUrl;
  }
  if (o.nips?.length) return nums.some((n) => o.nips!.includes(n));
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new CheckFailure(`${what} did not finish within ${ms} ms.`)),
        ms,
      );
    }),
  ]);
}

export async function runSuite(o: RunOptions): Promise<Report> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? 5000;
  const doFetch: SuiteContext['fetch'] = o.fetch ?? ((input, init) => fetch(input, init));
  const dial = o.dial ?? webSocketDialer;
  const httpUrl = httpUrlOf(o.relayUrl);
  const info = await fetchRelayInfo(httpUrl, doFetch, timeoutMs);
  const advertised = Array.isArray(info?.supported_nips)
    ? (info.supported_nips as unknown[]).filter((n): n is number => Number.isInteger(n))
    : [];
  const nips = new Set(advertised);
  const results: CheckResult[] = [];

  const makeCtx = (clients: RelayClient[]): SuiteContext => ({
    relayUrl: o.relayUrl,
    httpUrl,
    ...(o.blossomUrl ? { blossomUrl: o.blossomUrl } : {}),
    info,
    nips,
    timeoutMs,
    fetch: doFetch,
    dial,
    allowPrivateMirror: o.allowPrivateMirror ?? false,
    async connect() {
      const c = await RelayClient.connect(dial, o.relayUrl, timeoutMs);
      clients.push(c);
      return c;
    },
    key: newKey,
    sign: (k, t) => signEvent(k, t, Math.floor(Date.now() / 1000)),
    now: () => Math.floor(Date.now() / 1000),
  });

  const record = (r: CheckResult) => {
    results.push(r);
    o.onResult?.(r);
  };

  for (const c of ALL_CHECKS) {
    if (!selected(c, o)) continue;
    const base = { id: c.id, spec: c.spec, title: c.title };
    if (c.blossom && !o.blossomUrl) {
      record({ ...base, status: 'skip', message: 'No media server given.', durationMs: 0 });
      continue;
    }
    if (c.requiresNips && !o.all) {
      if (!info) {
        record({
          ...base,
          status: 'skip',
          message: 'The relay has no readable information document, so its features are unknown.',
          durationMs: 0,
        });
        continue;
      }
      if (!c.requiresNips.some((n) => nips.has(n))) {
        record({
          ...base,
          status: 'skip',
          message: `Not offered by this relay (NIP-${c.requiresNips.map((n) => String(n).padStart(2, '0')).join('/')} not in supported_nips).`,
          durationMs: 0,
        });
        continue;
      }
    }
    const clients: RelayClient[] = [];
    const start = Date.now();
    try {
      const msg = await withTimeout(
        c.run(makeCtx(clients)),
        Math.max(timeoutMs * 4, 20_000),
        'The check',
      );
      record({ ...base, status: 'pass', message: msg ?? 'OK', durationMs: Date.now() - start });
    } catch (err) {
      const status = err instanceof CheckSkip ? 'skip' : 'fail';
      const message =
        err instanceof CheckFailure || err instanceof CheckSkip
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      record({ ...base, status, message, durationMs: Date.now() - start });
    } finally {
      for (const cl of clients) cl.close();
    }
  }

  if (o.fuzz && o.fuzz > 0) {
    const clients: RelayClient[] = [];
    try {
      for (const r of await runFuzz(makeCtx(clients), o.fuzz, o.seed)) record(r);
    } finally {
      for (const cl of clients) cl.close();
    }
  }

  const count = (s: CheckResult['status']) => results.filter((r) => r.status === s).length;
  const report: Report = {
    target: { relay: o.relayUrl, ...(o.blossomUrl ? { blossom: o.blossomUrl } : {}) },
    supportedNips: [...nips].sort((a, b) => a - b),
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    results,
    summary: {
      pass: count('pass'),
      fail: count('fail'),
      skip: count('skip'),
      total: results.length,
    },
  };
  if (typeof info?.software === 'string') report.software = info.software;
  if (typeof info?.version === 'string') report.version = info.version;
  return report;
}
