// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Property-based fuzzing of the @beamhop/core parsers with a tiny seeded
 * generator: they must never throw, and anything they accept must really
 * have the promised shape.
 */
import { describe, expect, test } from 'bun:test';
import {
  type NostrEvent,
  finalizeEvent,
  generateSecretKey,
  parseClientMessage,
  validateEventShape,
  validateFilter,
} from '@beamhop/core';
import { FUZZ_CATEGORIES, Gen, deepArray, fuzzCases } from '../src/fuzz.ts';

const SEEDS = [1, 7, 42, 1337, 20261021];
const PER_SEED = 600;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function assertEventShape(e: NostrEvent) {
  expect(HEX64.test(e.id) && HEX64.test(e.pubkey) && HEX128.test(e.sig)).toBe(true);
  expect(Number.isInteger(e.created_at) && e.created_at >= 0).toBe(true);
  expect(Number.isInteger(e.kind) && e.kind >= 0 && e.kind <= 65535).toBe(true);
  expect(typeof e.content).toBe('string');
  const tagsOk =
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.length > 0 && t.every((v) => typeof v === 'string'));
  expect(tagsOk).toBe(true);
}

function assertFilterShape(f: Record<string, unknown>) {
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const nat = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  for (const [k, v] of Object.entries(f)) {
    if (k === 'ids' || k === 'authors') expect(strs(v)).toBe(true);
    else if (k === 'kinds') expect(Array.isArray(v) && v.every(nat)).toBe(true);
    else if (k === 'since' || k === 'until' || k === 'limit') expect(nat(v)).toBe(true);
    else if (k === 'search') expect(typeof v).toBe('string');
    else if (k.length === 2 && k[0] === '#') expect(strs(v)).toBe(true);
  }
}

/** Mutate a value: drop/replace a key, wrap, or replace with random JSON. */
function mutate(g: Gen, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && g.bool(0.7)) {
    const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    const keys = Object.keys(o);
    const k = keys.length ? g.pick(keys) : 'x';
    if (g.bool(0.3)) delete o[k];
    else o[k] = g.json(2);
    return o;
  }
  return g.bool(0.5) ? g.json(3) : [v];
}

const sk = generateSecretKey();
const validEvent = (g: Gen) =>
  finalizeEvent(
    {
      kind: g.int(40000),
      created_at: g.int(2 ** 31),
      content: g.string(30),
      tags: Array.from({ length: g.int(4) }, () => [g.pick(['e', 'p', 't', 'd']), g.string(10)]),
    },
    sk,
  );

describe('core parsers under random input', () => {
  for (const seed of SEEDS) {
    test(`parseClientMessage never throws on generated frames (seed ${seed})`, () => {
      const g = new Gen(seed);
      const base = validEvent(g);
      const cases = fuzzCases(PER_SEED, seed, {
        base,
        sign: (t) => finalizeEvent({ ...t, created_at: 1_700_000_000 }, sk),
        maxFrameBytes: 64 * 1024,
      });
      const seen = new Set<string>();
      for (const c of cases) {
        seen.add(c.category);
        const r = parseClientMessage(c.frame);
        if (!r.ok) {
          expect(typeof r.reason).toBe('string');
          expect(r.reason.length).toBeGreaterThan(0);
          continue;
        }
        const [type, ...rest] = r.message;
        expect(typeof type).toBe('string');
        if (type === 'EVENT' || type === 'AUTH') {
          const s = validateEventShape(rest[0]);
          if (s.ok) assertEventShape(s.event);
          else expect(s.reason.startsWith('invalid:')).toBe(true);
        }
        if (type === 'REQ' || type === 'COUNT') {
          for (const f of rest.slice(1)) {
            const fc = validateFilter(f);
            if (fc.ok) assertFilterShape(fc.filter as Record<string, unknown>);
            else expect(fc.reason.startsWith('invalid:')).toBe(true);
          }
        }
      }
      expect(seen.size).toBe(FUZZ_CATEGORIES.length);
    });

    test(`parseClientMessage never throws on arbitrary JSON and strings (seed ${seed})`, () => {
      const g = new Gen(seed);
      for (let i = 0; i < PER_SEED; i++) {
        const raw = g.bool(0.6)
          ? JSON.stringify([
              g.pick([
                'EVENT',
                'REQ',
                'CLOSE',
                'COUNT',
                'AUTH',
                'NEG-OPEN',
                'NEG-MSG',
                'NEG-CLOSE',
                g.string(6),
              ]),
              ...Array.from({ length: g.int(4) }, () => g.json(3)),
            ])
          : g.bool(0.5)
            ? g.string(80)
            : JSON.stringify(g.json(4));
        const r = parseClientMessage(raw);
        expect(typeof r.ok).toBe('boolean');
      }
    });

    test(`validateEventShape: accepts valid events, never throws on mutants (seed ${seed})`, () => {
      const g = new Gen(seed);
      for (let i = 0; i < PER_SEED / 4; i++) {
        const ev = validEvent(g);
        const ok = validateEventShape(JSON.parse(JSON.stringify(ev)));
        expect(ok.ok).toBe(true);
        for (let j = 0; j < 4; j++) {
          const m = mutate(g, ev);
          const r = validateEventShape(m);
          if (r.ok) assertEventShape(r.event);
        }
        // Uppercase hex is never valid.
        expect(validateEventShape({ ...ev, id: ev.id.toUpperCase() }).ok).toBe(
          ev.id === ev.id.toUpperCase(),
        );
      }
      for (let i = 0; i < PER_SEED; i++) {
        const r = validateEventShape(g.json(4));
        if (r.ok) assertEventShape(r.event);
      }
    });

    test(`validateFilter never throws and only accepts well-typed filters (seed ${seed})`, () => {
      const g = new Gen(seed);
      for (let i = 0; i < PER_SEED; i++) {
        const input = g.bool(0.5)
          ? g.json(3)
          : mutate(g, { kinds: [1], authors: [g.hex(64)], '#t': ['x'], limit: 10, since: 1 });
        const r = validateFilter(input);
        if (r.ok) assertFilterShape(r.filter as Record<string, unknown>);
      }
    });
  }

  test('deep nesting is rejected without crashing', () => {
    for (const depth of [1000, 10_000, 100_000]) {
      const r = parseClientMessage(`["REQ","x",{"#e":${deepArray(depth)}}]`);
      if (r.ok) {
        const f = validateFilter((r.message as unknown[])[2]);
        expect(f.ok).toBe(false);
      }
      const e = parseClientMessage(deepArray(depth, '"EVENT"'));
      expect(e.ok).toBe(false);
    }
  });
});
