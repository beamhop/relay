// SPDX-License-Identifier: AGPL-3.0-or-later
/** NIP-01: basic protocol. */
import { sleep } from '../client.ts';
import { type Check, check, expect, fail, randomHex, short, token } from '../types.ts';
import { ids, mustAccept, mustHavePrefix, mustRefuse, query, sameSet } from './util.ts';

const SPEC = 'NIP-01';

export const nip01Checks: Check[] = [
  check({
    id: 'nip01.connect',
    spec: SPEC,
    title: 'Accepts WebSocket connections',
    async run(ctx) {
      const c = await ctx.connect();
      expect(await c.ping(), 'Connected, but the relay did not answer a simple query.');
      return 'Connected and got an answer to a simple query.';
    },
  }),
  check({
    id: 'nip01.ok-valid',
    spec: SPEC,
    title: 'Accepts a valid signed note and confirms with OK',
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), { kind: 1, content: `conformance ${token()}` });
      await mustAccept(c, ev, 'a valid note');
      const got = await query(c, [{ ids: [ev.id] }]);
      expect(got.length === 1, 'The note was accepted but could not be read back by id.');
      expect(
        JSON.stringify(got[0]) === JSON.stringify(ev) || got[0]?.sig === ev.sig,
        'The note read back differs from what was published.',
      );
      return 'Note accepted (OK true) and read back unchanged.';
    },
  }),
  check({
    id: 'nip01.ok-bad-sig',
    spec: SPEC,
    title: 'Refuses events with an invalid signature',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const a = ctx.sign(k, { kind: 1, content: `a ${token()}` });
      const b = ctx.sign(k, { kind: 1, content: `b ${token()}` });
      const forged = { ...a, sig: b.sig };
      const why = await mustRefuse(c, forged, 'a note with a forged signature');
      mustHavePrefix(why);
      const got = await query(c, [{ ids: [a.id] }]);
      expect(got.length === 0, 'The forged note was refused but is still served.');
      return `Refused with "${short(why)}".`;
    },
  }),
  check({
    id: 'nip01.ok-bad-id',
    spec: SPEC,
    title: 'Refuses events whose id does not match the content',
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), { kind: 1, content: `orig ${token()}` });
      const tampered = { ...ev, content: `${ev.content} (edited)` };
      const why = await mustRefuse(c, tampered, 'a note edited after signing');
      mustHavePrefix(why);
      return `Refused with "${short(why)}".`;
    },
  }),
  check({
    id: 'nip01.ok-malformed',
    spec: SPEC,
    title: 'Refuses structurally broken events',
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), { kind: 1, content: token() });
      const broken = { ...ev, kind: 'one' } as unknown as Record<string, unknown>;
      const from = c.mark();
      c.send(['EVENT', broken]);
      const f = await c.waitFor((x) => x[0] === 'OK' || x[0] === 'NOTICE', from);
      expect(f, 'The relay did not answer a broken event at all.');
      if (f[0] === 'OK') expect(f[2] === false, 'The relay accepted an event with kind "one".');
      return `Answered with ${f[0]}.`;
    },
  }),
  check({
    id: 'nip01.ok-duplicate',
    spec: SPEC,
    title: 'Republishing the same event is acknowledged, not duplicated',
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), { kind: 1, content: `dup ${token()}` });
      await mustAccept(c, ev, 'a note');
      const r = await c.publish(ev);
      expect(r, 'No OK for the repeated note.');
      expect(r.accepted, `The repeated note was answered with OK false: "${short(r.message)}".`);
      const got = await query(c, [{ ids: [ev.id] }]);
      expect(got.length === 1, `Expected 1 stored copy, found ${got.length}.`);
      return r.message ? `Answered "${short(r.message)}".` : 'Answered OK true.';
    },
  }),
  check({
    id: 'nip01.req-ids',
    spec: SPEC,
    title: 'Finds events by id',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const a = ctx.sign(k, { kind: 1, content: token() });
      const b = ctx.sign(k, { kind: 1, content: token() });
      await mustAccept(c, a, 'note A');
      await mustAccept(c, b, 'note B');
      const got = await query(c, [{ ids: [a.id] }]);
      expect(sameSet(ids(got), [a.id]), `Asked for one id, got ${got.length} event(s).`);
      return 'Returned exactly the requested event.';
    },
  }),
  check({
    id: 'nip01.req-authors-kinds',
    spec: SPEC,
    title: 'Filters by author and kind',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const other = ctx.key();
      const n1 = ctx.sign(k, { kind: 1, content: token() });
      const n2 = ctx.sign(k, { kind: 1, content: token(), created_at: ctx.now() - 1 });
      const r = ctx.sign(k, { kind: 7, content: '+', tags: [['e', n1.id]] });
      const o = ctx.sign(other, { kind: 1, content: token() });
      for (const e of [n1, n2, r, o]) await mustAccept(c, e, `a kind ${e.kind} event`);
      const got = await query(c, [{ authors: [k.pk], kinds: [1] }]);
      expect(
        sameSet(ids(got), [n1.id, n2.id]),
        `Expected the author's 2 notes, got ${got.length} event(s) (kinds ${got.map((e) => e.kind).join(',')}).`,
      );
      const both = await query(c, [{ authors: [k.pk, other.pk], kinds: [1, 7] }]);
      expect(both.length === 4, `Expected 4 events for two authors, got ${both.length}.`);
      return 'authors + kinds filters matched exactly.';
    },
  }),
  check({
    id: 'nip01.req-tags',
    spec: SPEC,
    title: 'Filters by single-letter tags (#e, #p, #t)',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const topic = token();
      const p = ctx.key().pk;
      const tagged = ctx.sign(k, {
        kind: 1,
        content: token(),
        tags: [
          ['t', topic],
          ['p', p],
        ],
      });
      const plain = ctx.sign(k, { kind: 1, content: token(), tags: [['t', `${topic}x`]] });
      await mustAccept(c, tagged, 'a tagged note');
      await mustAccept(c, plain, 'a second note');
      const byT = await query(c, [{ '#t': [topic] }]);
      expect(sameSet(ids(byT), [tagged.id]), `#t filter returned ${byT.length} event(s).`);
      const byP = await query(c, [{ '#p': [p] }]);
      expect(sameSet(ids(byP), [tagged.id]), `#p filter returned ${byP.length} event(s).`);
      const both = await query(c, [{ '#t': [topic], '#p': [ctx.key().pk] }]);
      expect(both.length === 0, 'Two tag conditions must both match (AND), but got results.');
      return '#t and #p filters matched exactly; tag conditions combine with AND.';
    },
  }),
  check({
    id: 'nip01.req-since-until',
    spec: SPEC,
    title: 'Respects since and until',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const now = ctx.now();
      const evs = [300, 200, 100].map((ago) =>
        ctx.sign(k, { kind: 1, content: token(), created_at: now - ago }),
      );
      for (const e of evs) await mustAccept(c, e, 'a back-dated note');
      const mid = await query(c, [{ authors: [k.pk], since: now - 250, until: now - 150 }]);
      expect(sameSet(ids(mid), [evs[1]!.id]), `since/until window returned ${mid.length} events.`);
      const edge = await query(c, [{ authors: [k.pk], since: now - 200, until: now - 200 }]);
      expect(sameSet(ids(edge), [evs[1]!.id]), 'since/until must be inclusive.');
      return 'Window and inclusive bounds behave as specified.';
    },
  }),
  check({
    id: 'nip01.req-limit-order',
    spec: SPEC,
    title: 'limit returns the newest events, newest first',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const now = ctx.now();
      const evs = [50, 40, 30, 20, 10].map((ago) =>
        ctx.sign(k, { kind: 1, content: token(), created_at: now - ago }),
      );
      for (const e of evs) await mustAccept(c, e, 'a note');
      const got = await query(c, [{ authors: [k.pk], limit: 3 }]);
      expect(got.length === 3, `limit 3 returned ${got.length} events.`);
      const want = [evs[4]!.id, evs[3]!.id, evs[2]!.id];
      expect(
        ids(got).join() === want.join(),
        'Events were not the 3 newest in newest-first order.',
      );
      const zero = await query(c, [{ authors: [k.pk], limit: 0 }]);
      expect(zero.length === 0, `limit 0 should return no stored events, got ${zero.length}.`);
      return 'limit picks the newest events in descending created_at order.';
    },
  }),
  check({
    id: 'nip01.req-multi-filter',
    spec: SPEC,
    title: 'Several filters in one REQ combine with OR',
    async run(ctx) {
      const c = await ctx.connect();
      const a = ctx.sign(ctx.key(), { kind: 1, content: token() });
      const b = ctx.sign(ctx.key(), { kind: 1, content: token() });
      await mustAccept(c, a, 'note A');
      await mustAccept(c, b, 'note B');
      const got = await query(c, [{ ids: [a.id] }, { authors: [b.pubkey] }]);
      expect(sameSet(ids(got), [a.id, b.id]), `Expected both notes, got ${got.length}.`);
      return 'Both filters contributed results.';
    },
  }),
  check({
    id: 'nip01.eose',
    spec: SPEC,
    title: 'Sends EOSE even when nothing matches',
    async run(ctx) {
      const c = await ctx.connect();
      const r = await c.req([{ ids: [randomHex()] }]);
      expect(!r.timedOut, 'No EOSE for a query with no matches.');
      expect(r.eose, `Expected EOSE, got CLOSED "${short(r.closed ?? '')}".`);
      expect(r.events.length === 0, 'A random id matched an event.');
      return 'EOSE received.';
    },
  }),
  check({
    id: 'nip01.live',
    spec: SPEC,
    title: 'Delivers new matching events to open subscriptions',
    async run(ctx) {
      const sub = await ctx.connect();
      const pub = await ctx.connect();
      const k = ctx.key();
      const r = await sub.req([{ authors: [k.pk] }], { keepOpen: true });
      expect(r.eose, 'Subscription did not reach EOSE.');
      const ev = ctx.sign(k, { kind: 1, content: token() });
      const from = sub.mark();
      await mustAccept(pub, ev, 'a note');
      const got = await sub.waitFor(
        (f) => f[0] === 'EVENT' && f[1] === r.subId && (f[2] as { id?: string })?.id === ev.id,
        from,
      );
      expect(got, 'The open subscription never received the new note.');
      return 'New note delivered live after EOSE.';
    },
  }),
  check({
    id: 'nip01.close',
    spec: SPEC,
    title: 'CLOSE stops a subscription',
    async run(ctx) {
      const sub = await ctx.connect();
      const pub = await ctx.connect();
      const k = ctx.key();
      const r = await sub.req([{ authors: [k.pk] }], { keepOpen: true });
      expect(r.eose, 'Subscription did not reach EOSE.');
      sub.send(['CLOSE', r.subId]);
      expect(await sub.ping(), 'Relay stopped answering after CLOSE.');
      const from = sub.mark();
      await mustAccept(pub, ctx.sign(k, { kind: 1, content: token() }), 'a note');
      await sleep(Math.min(1000, ctx.timeoutMs / 4));
      const leaked = sub.since(from).some((f) => f[0] === 'EVENT' && f[1] === r.subId);
      expect(!leaked, 'Events still arrived on a closed subscription.');
      return 'No events after CLOSE.';
    },
  }),
  check({
    id: 'nip01.closed',
    spec: SPEC,
    title: 'Refuses an invalid filter with CLOSED',
    async run(ctx) {
      const c = await ctx.connect();
      const subId = c.subId('bad');
      const from = c.mark();
      c.send(['REQ', subId, { kinds: 'all' }]);
      const f = await c.waitFor(
        (x) => (x[1] === subId && (x[0] === 'CLOSED' || x[0] === 'EOSE')) || x[0] === 'NOTICE',
        from,
      );
      expect(f, 'No answer to a REQ with an invalid filter.');
      if (f[0] === 'EOSE') fail('The relay treated {"kinds":"all"} as a valid filter.');
      if (f[0] === 'NOTICE')
        fail(`Answered with NOTICE ("${short(String(f[1]))}") instead of CLOSED for the sub.`);
      expect(typeof f[2] === 'string', 'CLOSED must carry a reason string.');
      return `CLOSED with "${short(f[2] as string)}".`;
    },
  }),
  check({
    id: 'nip01.notice',
    spec: SPEC,
    title: 'Survives garbage input and keeps the connection usable',
    async run(ctx) {
      const c = await ctx.connect();
      const from = c.mark();
      c.sendRaw('this is not json');
      const n = await c.waitFor((x) => x[0] === 'NOTICE', from);
      expect(c.closed || (await c.ping()), 'Relay stopped answering after a garbage frame.');
      return n
        ? `Answered NOTICE "${short(String(n[1]))}" and kept working.`
        : 'Ignored the garbage frame and kept working.';
    },
  }),
  check({
    id: 'nip01.replaceable',
    spec: SPEC,
    title: 'Replaceable events (kind 0, 3, 10000–19999) keep only the newest',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const now = ctx.now();
      const older = ctx.sign(k, { kind: 0, content: '{"name":"old"}', created_at: now - 10 });
      const newer = ctx.sign(k, { kind: 0, content: '{"name":"new"}', created_at: now - 5 });
      await mustAccept(c, older, 'a profile');
      await mustAccept(c, newer, 'a newer profile');
      let got = await query(c, [{ authors: [k.pk], kinds: [0] }]);
      expect(sameSet(ids(got), [newer.id]), `Expected only the newest profile, got ${got.length}.`);
      // An older version arriving later must not win.
      const stale = ctx.sign(k, { kind: 0, content: '{"name":"stale"}', created_at: now - 20 });
      await c.publish(stale);
      got = await query(c, [{ authors: [k.pk], kinds: [0] }]);
      expect(sameSet(ids(got), [newer.id]), 'An older profile replaced a newer one.');
      const list = ctx.sign(k, { kind: 10002, tags: [['r', 'wss://a.example']] });
      const list2 = ctx.sign(k, {
        kind: 10002,
        tags: [['r', 'wss://b.example']],
        created_at: list.created_at + 1,
      });
      await mustAccept(c, list, 'a relay list');
      await mustAccept(c, list2, 'a newer relay list');
      got = await query(c, [{ authors: [k.pk], kinds: [10002] }]);
      expect(sameSet(ids(got), [list2.id]), 'kind 10002 kept more than the newest version.');
      return 'Only the newest version is stored for kinds 0 and 10002.';
    },
  }),
  check({
    id: 'nip01.addressable',
    spec: SPEC,
    title: 'Addressable events (30000–39999) are replaced per d tag',
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const now = ctx.now();
      const d = token();
      const v1 = ctx.sign(k, { kind: 30078, tags: [['d', d]], content: 'v1', created_at: now - 5 });
      const v2 = ctx.sign(k, { kind: 30078, tags: [['d', d]], content: 'v2', created_at: now });
      const other = ctx.sign(k, { kind: 30078, tags: [['d', `${d}-2`]], content: 'x' });
      for (const e of [v1, v2, other]) await mustAccept(c, e, 'an addressable event');
      const got = await query(c, [{ authors: [k.pk], kinds: [30078] }]);
      expect(
        sameSet(ids(got), [v2.id, other.id]),
        `Expected newest per d tag (2 events), got ${got.length}.`,
      );
      const byD = await query(c, [{ authors: [k.pk], kinds: [30078], '#d': [d] }]);
      expect(sameSet(ids(byD), [v2.id]), '#d lookup did not return the newest version.');
      return 'Newest version kept per (kind, author, d).';
    },
  }),
  check({
    id: 'nip01.ephemeral',
    spec: SPEC,
    title: 'Ephemeral events (20000–29999) are relayed but not stored',
    async run(ctx) {
      const sub = await ctx.connect();
      const pub = await ctx.connect();
      const k = ctx.key();
      const r = await sub.req([{ authors: [k.pk], kinds: [20001] }], { keepOpen: true });
      expect(r.eose, 'Subscription did not reach EOSE.');
      const ev = ctx.sign(k, { kind: 20001, content: token() });
      const from = sub.mark();
      await mustAccept(pub, ev, 'an ephemeral event');
      const live = await sub.waitFor(
        (f) => f[0] === 'EVENT' && (f[2] as { id?: string })?.id === ev.id,
        from,
      );
      expect(live, 'The ephemeral event was not delivered to a live subscriber.');
      const stored = await query(pub, [{ ids: [ev.id] }]);
      expect(stored.length === 0, 'The ephemeral event was stored and served later.');
      return 'Delivered live, not stored.';
    },
  }),
];
