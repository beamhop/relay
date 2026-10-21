// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Protocol fuzzing. Generates malformed frames (broken JSON, wrong types, deep
 * nesting, invalid hex, unicode edge cases, huge tag lists, oversize frames)
 * and checks that a relay keeps answering — with NOTICE / OK false / CLOSED —
 * and never crashes or hangs. Deterministic for a given seed.
 *
 * The generators are exported for in-process property tests of the parsers.
 */
import type { NostrEvent } from '@beamhop/core';
import type { RelayClient } from './client.ts';
import type { CheckResult, SuiteContext } from './types.ts';

// ───────────────────────────── random ─────────────────────────────

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Awkward strings that tend to break parsers, encoders and databases. */
export const NASTY_STRINGS: readonly string[] = [
  '',
  ' ',
  '\u0000',
  '\u0000\u0001\u001f',
  '\ud800',
  '\udfff',
  '\ud83d',
  '﻿',
  '￿',
  '‮',
  '​',
  'é',
  'é',
  '🏳️‍🌈',
  '👨‍👩‍👧‍👦',
  '𝕳𝖊𝖑𝖑𝖔',
  'ＡＢＣ',
  'Ω≈ç√∫',
  '\\',
  '"',
  "'; DROP TABLE events; --",
  '%s%s%n',
  '${7*7}',
  '<script>alert(1)</script>',
  '../../../../etc/passwd',
  'null',
  'undefined',
  'NaN',
  '-0',
  '1e400',
  '\r\n',
  '\t',
  'a'.repeat(1000),
];

export class Gen {
  readonly rand: () => number;
  constructor(readonly seed: number) {
    this.rand = mulberry32(seed);
  }
  int(max: number): number {
    return Math.floor(this.rand() * max);
  }
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }
  bool(p = 0.5): boolean {
    return this.rand() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  hex(n: number, alphabet = '0123456789abcdef'): string {
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[this.int(alphabet.length)];
    return s;
  }
  /** Random string mixing ASCII, nasty strings and arbitrary code units. */
  string(maxLen = 40): string {
    const r = this.int(4);
    if (r === 0) return this.pick(NASTY_STRINGS);
    const len = this.int(maxLen + 1);
    let s = '';
    for (let i = 0; i < len; i++) {
      const k = this.int(10);
      if (k < 6) s += String.fromCharCode(32 + this.int(95));
      else if (k < 8) s += String.fromCharCode(this.int(0x10000));
      else if (k < 9) s += String.fromCodePoint(0x10000 + this.int(0xfffff));
      else s += this.pick(NASTY_STRINGS);
    }
    return s;
  }
  number(): number {
    return this.pick([
      0,
      -1,
      1,
      1.5,
      -0.5,
      2 ** 31,
      2 ** 53,
      -(2 ** 53),
      Number.MAX_SAFE_INTEGER + 2,
      1e300,
      65536,
      this.int(100000),
      this.rand(),
    ]);
  }
  /** Arbitrary JSON value (bounded depth). */
  json(depth = 3): unknown {
    const r = this.int(depth <= 0 ? 4 : 7);
    switch (r) {
      case 0:
        return null;
      case 1:
        return this.bool();
      case 2:
        return this.number();
      case 3:
        return this.string();
      case 4:
      case 5: {
        const n = this.int(5);
        return Array.from({ length: n }, () => this.json(depth - 1));
      }
      default: {
        const o: Record<string, unknown> = {};
        const n = this.int(5);
        const keys = [
          'id',
          'pubkey',
          'sig',
          'kind',
          'kinds',
          'tags',
          'content',
          'created_at',
          'ids',
          'authors',
          'since',
          'until',
          'limit',
          'search',
          '#e',
          '#p',
          '#t',
          '__proto__',
          'constructor',
        ];
        for (let i = 0; i < n; i++)
          o[this.bool(0.8) ? this.pick(keys) : this.string(8)] = this.json(depth - 1);
        return o;
      }
    }
  }
}

/** `[[[[…]]]]` nested `depth` levels, built without recursion. */
export function deepArray(depth: number, inner = '"x"'): string {
  return `${'['.repeat(depth)}${inner}${']'.repeat(depth)}`;
}

// ───────────────────────────── cases ─────────────────────────────

export type Expectation = 'reject' | 'survive';

export interface FuzzCase {
  category: string;
  frame: string;
  /** reject: the relay must answer with a refusal (or close the connection). */
  expect: Expectation;
}

export interface CaseOptions {
  /** A correctly signed event to mutate. */
  base: NostrEvent;
  /** Sign arbitrary templates (for valid-but-weird events). */
  sign?: (t: { kind: number; content: string; tags: string[][] }) => NostrEvent;
  /** Largest frame to generate in the oversize category (bytes). */
  maxFrameBytes?: number;
  /** Relay's advertised max message length, if known. */
  maxMessageLength?: number;
}

const KNOWN = ['EVENT', 'REQ', 'CLOSE', 'AUTH', 'COUNT', 'NEG-OPEN', 'NEG-MSG', 'NEG-CLOSE'];

type Maker = (g: Gen, o: CaseOptions) => FuzzCase;

/** Stands for the JSON literal 1e400 (parses to Infinity), which JS cannot hold as a number. */
const HUGE = '__1e400__';
const huge = (json: string) => json.replaceAll(`"${HUGE}"`, '1e400');
const evFrame = (e: unknown) => huge(JSON.stringify(['EVENT', e]));
const reqFrame = (sub: unknown, ...filters: unknown[]) => JSON.stringify(['REQ', sub, ...filters]);

/** One field of a valid event replaced with something structurally wrong. */
function brokenEvent(g: Gen, base: NostrEvent): Record<string, unknown> {
  const e: Record<string, unknown> = { ...base };
  const bad: Array<() => void> = [
    () => {
      e.kind = g.pick(['1', 1.5, -1, 65536, 2 ** 53, null, [], {}, true]);
    },
    () => {
      e.created_at = g.pick(['now', -5, 1.25, null, [], HUGE]);
    },
    () => {
      e.tags = g.pick([null, 'tags', {}, [1, 2], [[1]], [[]], [['p', null]], [['e', {}]]]);
    },
    () => {
      e.content = g.pick([null, 1, [], {}, true]);
    },
    () => {
      e.id = g.pick([
        base.id.toUpperCase(),
        base.id.slice(1),
        `${base.id}0`,
        g.hex(64, 'ghijklmnopqrstuvwxyz'),
        '',
        null,
        42,
      ]);
    },
    () => {
      e.pubkey = g.pick([base.pubkey.toUpperCase(), base.pubkey.slice(2), g.hex(64, 'xyz'), 7]);
    },
    () => {
      e.sig = g.pick([base.sig.slice(0, 64), base.sig.toUpperCase(), g.hex(128, 'zq'), null]);
    },
    () => {
      for (const k of ['id', 'pubkey', 'sig', 'kind', 'tags', 'content', 'created_at'])
        if (g.bool(0.3)) e[k] = undefined; // dropped by JSON.stringify
      e.sig = undefined;
    },
  ];
  g.pick(bad)();
  return e;
}

const MAKERS: Record<string, Maker> = {
  'not-json': (g) => {
    const frame = g.pick([
      '[',
      '{"',
      '["EVENT",',
      '["REQ","x",{]',
      "['REQ','x',{}]",
      '["EVENT" {}]',
      `["REQ","x",{"kinds":[1]}]${g.string(4)}garbage`,
      `\u0000${g.string(8)}`,
      'NaN',
      '[1,2,3,]',
      `"${g.string(10).replace(/"/g, '')}`,
    ]);
    return { category: 'not-json', frame, expect: 'reject' };
  },
  'not-array': (g) => ({
    category: 'not-array',
    frame: JSON.stringify(g.pick([null, 0, 'EVENT', { EVENT: {} }, true, [], [1, 'EVENT']])),
    expect: 'reject',
  }),
  'unknown-type': (g) => {
    let t = g.string(12);
    if (KNOWN.includes(t)) t = `${t}?`;
    return {
      category: 'unknown-type',
      frame: JSON.stringify([g.pick([t, 'event', 'req', 'Req', 'EVENTS', 'PING']), g.json(2)]),
      expect: 'reject',
    };
  },
  'event-wrong-types': (g, o) => ({
    category: 'event-wrong-types',
    frame: evFrame(brokenEvent(g, o.base)),
    expect: 'reject',
  }),
  'event-bad-sig': (g, o) => {
    // Content changed after signing (never equal to the original), or a foreign signature.
    const e = g.bool()
      ? { ...o.base, content: `${o.base.content}!${g.string(5)}` }
      : { ...o.base, sig: g.hex(128) };
    return { category: 'event-bad-sig', frame: evFrame(e), expect: 'reject' };
  },
  'huge-tags': (g, o) => {
    const n = g.range(2000, 12000);
    const tags = Array.from({ length: n }, (_, i) => ['t', `x${i}`]);
    // Signature left stale: the event is invalid however large the relay's limits are.
    return { category: 'huge-tags', frame: evFrame({ ...o.base, tags }), expect: 'reject' };
  },
  'deep-nesting': (g, o) => {
    const depth = g.pick([200, 1000, 5000, 20000]);
    const variant = g.int(4);
    let frame: string;
    if (variant === 0)
      frame = `["EVENT",${JSON.stringify({ ...o.base, tags: [] }).replace('"tags":[]', `"tags":[${deepArray(depth)}]`)}]`;
    else if (variant === 1) frame = `["REQ","deep",{"#e":${deepArray(depth)}}]`;
    else if (variant === 2) frame = deepArray(depth, '"REQ"');
    else frame = `["REQ","deep",${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}, {"kinds":"x"}]`;
    return { category: 'deep-nesting', frame, expect: 'reject' };
  },
  'bad-filter': (g) => {
    const filter = g.pick<unknown>([
      { kinds: 'all' },
      { kinds: [-1] },
      { kinds: [1.5] },
      { kinds: [HUGE] },
      { kinds: ['1'] },
      { limit: -1 },
      { limit: 'ten' },
      { since: 1.5 },
      { until: '2024' },
      { ids: 'abc' },
      { ids: [1, 2] },
      { authors: [null] },
      { '#e': 'abc' },
      { '#p': [1] },
      { search: 5 },
      null,
      [],
      'filter',
      42,
    ]);
    const kind = g.pick(['REQ', 'COUNT']);
    return {
      category: 'bad-filter',
      frame: huge(JSON.stringify([kind, `f${g.int(1000)}`, filter])),
      expect: 'reject',
    };
  },
  'bad-subid': (g) => ({
    category: 'bad-subid',
    frame: reqFrame(g.pick<unknown>(['', 'x'.repeat(65 + g.int(500)), 7, null, {}, []]), {
      kinds: [1],
      limit: 1,
    }),
    expect: 'reject',
  }),
  arity: (g, o) => ({
    category: 'arity',
    frame: JSON.stringify(
      g.pick<unknown[]>([
        ['EVENT'],
        ['EVENT', o.base, o.base],
        ['REQ'],
        ['CLOSE'],
        ['CLOSE', 5],
        ['AUTH'],
        ['AUTH', 'token'],
        ['COUNT'],
        ['NEG-OPEN'],
        ['NEG-MSG', 1],
      ]),
    ),
    expect: 'reject',
  }),
  'invalid-hex': (g) => ({
    // NIP-01 asks clients for exact 64-char lowercase hex; relays may refuse or match nothing.
    category: 'invalid-hex',
    frame: reqFrame(`h${g.int(1000)}`, {
      [g.pick(['ids', 'authors', '#e', '#p'])]: [
        g.pick([g.hex(64).toUpperCase(), g.hex(63), g.hex(65), g.hex(64, 'xyz'), '', g.string(10)]),
      ],
      limit: 1,
    }),
    expect: 'survive',
  }),
  unicode: (g, o) => {
    const content = Array.from({ length: g.range(1, 8) }, () => g.pick(NASTY_STRINGS)).join('');
    const tags = [
      ['t', g.pick(NASTY_STRINGS)],
      [g.pick(NASTY_STRINGS), g.string(6)],
    ].filter((t) => t[0] !== '');
    if (o.sign && g.bool(0.7)) {
      return {
        category: 'unicode',
        frame: evFrame(o.sign({ kind: 1, content, tags })),
        expect: 'survive',
      };
    }
    return {
      category: 'unicode',
      frame: reqFrame(g.pick(NASTY_STRINGS) || 'u', { '#t': [content], limit: 1 }),
      expect: 'survive',
    };
  },
  oversize: (g, o) => {
    const cap = o.maxFrameBytes ?? 2 * 1024 * 1024;
    const want = Math.min(cap, Math.max((o.maxMessageLength ?? 512 * 1024) + 1024, 64 * 1024));
    const content = 'A'.repeat(want + g.int(1024));
    return {
      category: 'oversize',
      frame: evFrame({ ...o.base, content }),
      expect: 'reject',
    };
  },
  'neg-garbage': (g) => ({
    category: 'neg-garbage',
    frame: JSON.stringify(
      g.pick<unknown[]>([
        ['NEG-OPEN', `n${g.int(100)}`, { kinds: [1] }, g.hex(31)],
        ['NEG-OPEN', `n${g.int(100)}`, { kinds: [1] }, 'zz'],
        ['NEG-OPEN', `n${g.int(100)}`, { kinds: [1] }, '61ffffffffffffffffffff'],
        ['NEG-MSG', `unknown-${g.int(100)}`, '6100'],
      ]),
    ),
    expect: 'reject',
  }),
};

export const FUZZ_CATEGORIES = Object.keys(MAKERS);

/** Deterministic list of `n` cases cycling through all categories. */
export function fuzzCases(n: number, seed: number, o: CaseOptions): FuzzCase[] {
  const g = new Gen(seed);
  const out: FuzzCase[] = [];
  for (let i = 0; i < n; i++) {
    const cat = FUZZ_CATEGORIES[i % FUZZ_CATEGORIES.length]!;
    out.push(MAKERS[cat]!(g, o));
  }
  return out;
}

// ───────────────────────────── runner ─────────────────────────────

export interface FuzzOutcome {
  case: FuzzCase;
  answer: string;
  ok: boolean;
}

const REFUSAL = new Set(['NOTICE', 'CLOSED', 'NEG-ERR']);

function describeCase(c: FuzzCase): string {
  const f = c.frame.length > 80 ? `${c.frame.slice(0, 80)}… (${c.frame.length} bytes)` : c.frame;
  return `[${c.category}] ${JSON.stringify(f)}`;
}

/** Fuzz a relay with `n` frames. Returns two results: liveness and refusals. */
export async function runFuzz(
  ctx: SuiteContext,
  n: number,
  seed = Date.now() % 2 ** 31,
): Promise<CheckResult[]> {
  const t0 = Date.now();
  const key = ctx.key();
  const base = ctx.sign(key, { kind: 1, content: 'fuzz base' });
  const maxLen = Number(ctx.info?.limitation?.max_message_length) || undefined;
  const cases = fuzzCases(n, seed, {
    base,
    sign: (t) => ctx.sign(key, t),
    ...(maxLen ? { maxMessageLength: maxLen } : {}),
  });
  const answerWait = Math.min(ctx.timeoutMs, 3000);
  const outcomes: FuzzOutcome[] = [];
  const hangs: string[] = [];
  let crash: string | null = null;
  let client: RelayClient | null = null;

  for (const fc of cases) {
    try {
      client ??= await ctx.connect();
    } catch (err) {
      crash = `The relay stopped accepting connections after ${describeCase(outcomes.at(-1)?.case ?? fc)}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    const c: RelayClient = client;
    const from = c.mark();
    c.sendRaw(fc.frame);
    const f = await c.waitFor(
      (x) => ['NOTICE', 'OK', 'CLOSED', 'NEG-ERR', 'EOSE', 'COUNT', 'NEG-MSG'].includes(x[0]),
      from,
      answerWait,
    );
    let answer: string;
    let ok: boolean;
    if (!f) {
      answer = c.closed ? `connection closed (${c.closeCode ?? '?'})` : 'no answer';
      ok = c.closed || fc.expect === 'survive';
    } else if (f[0] === 'OK') {
      answer = `OK ${String(f[2])} ${String(f[3] ?? '')}`.trim();
      // "duplicate:" means nothing new was stored (relays may dedupe by id before verifying).
      ok =
        f[2] === false ||
        fc.expect === 'survive' ||
        (typeof f[3] === 'string' && f[3].startsWith('duplicate:'));
    } else {
      answer =
        `${f[0]} ${typeof f[2] === 'string' ? f[2] : typeof f[1] === 'string' && f[0] === 'NOTICE' ? f[1] : ''}`.trim();
      ok = REFUSAL.has(f[0]) || fc.expect === 'survive';
    }
    outcomes.push({ case: fc, answer, ok });
    if (c.closed) {
      client = null;
      continue;
    }
    if (!(await c.ping(Math.min(ctx.timeoutMs, 5000)))) {
      hangs.push(describeCase(fc));
      c.close();
      client = null;
    }
  }
  // Final liveness probe on a fresh connection.
  if (!crash) {
    try {
      const c = await ctx.connect();
      if (!(await c.ping())) crash = 'The relay accepts connections but no longer answers queries.';
    } catch (err) {
      crash = `The relay stopped accepting connections: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const durationMs = Date.now() - t0;
  const bad = outcomes.filter((o) => !o.ok);
  const byCat = new Map<string, { n: number; bad: number }>();
  for (const o of outcomes) {
    const s = byCat.get(o.case.category) ?? { n: 0, bad: 0 };
    s.n++;
    if (!o.ok) s.bad++;
    byCat.set(o.case.category, s);
  }
  const live: CheckResult = {
    id: 'fuzz.liveness',
    spec: 'fuzz',
    title: `Stays up and responsive under ${n} malformed messages (seed ${seed})`,
    status: crash || hangs.length ? 'fail' : 'pass',
    message: crash
      ? crash
      : hangs.length
        ? `Stopped answering after ${hangs.length} message(s), e.g. ${hangs.slice(0, 3).join('; ')}`
        : `Answered every follow-up query after ${outcomes.length} malformed messages.`,
    durationMs,
  };
  const refusals: CheckResult = {
    id: 'fuzz.refusals',
    spec: 'fuzz',
    title: 'Answers malformed messages with NOTICE / OK false / CLOSED',
    status: bad.length ? 'fail' : outcomes.length ? 'pass' : 'skip',
    message: bad.length
      ? `${bad.length} of ${outcomes.length} malformed messages were not refused. Examples: ${bad
          .slice(0, 4)
          .map((o) => `${describeCase(o.case)} → ${o.answer}`)
          .join('; ')}. By category: ${[...byCat]
          .filter(([, s]) => s.bad)
          .map(([k, s]) => `${k} ${s.bad}/${s.n}`)
          .join(', ')}`
      : `All ${outcomes.length} malformed messages were refused or safely ignored.`,
    durationMs: 0,
  };
  return [live, refusals];
}
