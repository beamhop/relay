// SPDX-License-Identifier: AGPL-3.0-or-later
/** NIP-09, 11, 13, 17/59, 29, 40, 42, 45, 50, 62, 65, 70, 77. */
import type { NostrEvent } from '@beamhop/core';
import { Negentropy, NegentropyStorageVector } from '@beamhop/relay';
import { minePow } from 'nostr-tools/nip13';
import { wrapEvent } from 'nostr-tools/nip59';
import { finalizeEvent } from 'nostr-tools/pure';
import { type RelayClient, sleep } from '../client.ts';
import {
  type Check,
  type Key,
  type SuiteContext,
  check,
  expect,
  fail,
  randomHex,
  short,
  skip,
  token,
} from '../types.ts';
import { ids, mustAccept, mustHavePrefix, mustRefuse, query, sameSet } from './util.ts';

/** NIP-42 sign-in on a connection. */
export async function authenticate(
  ctx: SuiteContext,
  c: RelayClient,
  key: Key,
  over: { relay?: string; challenge?: string } = {},
) {
  const challenge = await c.challenge();
  if (!challenge) fail('The relay never sent an AUTH challenge, so signing in is impossible.');
  const ev = ctx.sign(key, {
    kind: 22242,
    tags: [
      ['relay', over.relay ?? ctx.relayUrl],
      ['challenge', over.challenge ?? challenge],
    ],
  });
  const r = await c.auth(ev);
  expect(r, 'The relay did not answer the AUTH message with OK.');
  return r;
}

async function mustAuth(ctx: SuiteContext, c: RelayClient, key: Key) {
  const r = await authenticate(ctx, c, key);
  expect(r.accepted, `Signing in failed: "${short(r.message)}".`);
}

// ───────────────────────────── NIP-09 ─────────────────────────────

const nip09: Check[] = [
  check({
    id: 'nip09.delete-by-id',
    spec: 'NIP-09',
    title: 'Authors can delete their events by id',
    requiresNips: [9],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const note = ctx.sign(k, { kind: 1, content: token() });
      await mustAccept(c, note, 'a note');
      const del = ctx.sign(k, {
        kind: 5,
        tags: [
          ['e', note.id],
          ['k', '1'],
        ],
        content: 'conformance test',
      });
      await mustAccept(c, del, 'a deletion request');
      const got = await query(c, [{ ids: [note.id] }]);
      expect(got.length === 0, 'The deleted note is still served.');
      const delServed = await query(c, [{ ids: [del.id] }]);
      expect(delServed.length === 1, 'The deletion request itself should keep being served.');
      const again = await c.publish(note);
      const after = await query(c, [{ ids: [note.id] }]);
      expect(after.length === 0, 'Re-publishing a deleted note brought it back.');
      return `Deleted; re-publish ${again?.accepted === false ? 'refused' : 'ignored'}.`;
    },
  }),
  check({
    id: 'nip09.delete-other-author',
    spec: 'NIP-09',
    title: "Nobody can delete someone else's events",
    requiresNips: [9],
    async run(ctx) {
      const c = await ctx.connect();
      const victim = ctx.sign(ctx.key(), { kind: 1, content: token() });
      await mustAccept(c, victim, 'a note');
      const del = ctx.sign(ctx.key(), { kind: 5, tags: [['e', victim.id]] });
      await c.publish(del);
      const got = await query(c, [{ ids: [victim.id] }]);
      expect(got.length === 1, "A stranger's deletion request removed the note.");
      return 'Note survived a deletion request from another key.';
    },
  }),
  check({
    id: 'nip09.delete-by-address',
    spec: 'NIP-09',
    title: 'Addressable events can be deleted by address (a tag)',
    requiresNips: [9],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const d = token();
      const ev = ctx.sign(k, { kind: 30078, tags: [['d', d]], created_at: ctx.now() - 5 });
      await mustAccept(c, ev, 'an addressable event');
      await mustAccept(
        c,
        ctx.sign(k, { kind: 5, tags: [['a', `30078:${k.pk}:${d}`]] }),
        'a deletion by address',
      );
      const got = await query(c, [{ authors: [k.pk], kinds: [30078], '#d': [d] }]);
      expect(got.length === 0, 'The addressable event is still served after deletion.');
      return 'Deleted by address.';
    },
  }),
];

// ───────────────────────────── NIP-11 ─────────────────────────────

const nip11: Check[] = [
  check({
    id: 'nip11.document',
    spec: 'NIP-11',
    title: 'Publishes a relay information document',
    async run(ctx) {
      const res = await ctx.fetch(ctx.httpUrl, { headers: { accept: 'application/nostr+json' } });
      expect(res.ok, `GET with Accept: application/nostr+json answered HTTP ${res.status}.`);
      let doc: Record<string, unknown>;
      try {
        doc = (await res.json()) as Record<string, unknown>;
      } catch {
        fail('The information document is not valid JSON.');
      }
      expect(doc && typeof doc === 'object' && !Array.isArray(doc), 'Document is not an object.');
      const problems: string[] = [];
      const str = (k: string) => {
        if (doc[k] !== undefined && typeof doc[k] !== 'string') problems.push(`${k} not a string`);
      };
      for (const k of ['name', 'description', 'pubkey', 'contact', 'software', 'version']) str(k);
      const nips = doc.supported_nips;
      if (nips !== undefined) {
        if (!Array.isArray(nips) || !nips.every((n) => Number.isInteger(n)))
          problems.push('supported_nips must be an array of integers');
      }
      if (typeof doc.pubkey === 'string' && !/^[0-9a-f]{64}$/.test(doc.pubkey))
        problems.push('pubkey must be 64 lowercase hex characters');
      const lim = doc.limitation;
      if (lim !== undefined && (typeof lim !== 'object' || lim === null || Array.isArray(lim)))
        problems.push('limitation must be an object');
      expect(problems.length === 0, `Document fields are wrong: ${problems.join('; ')}.`);
      return `name="${short(String(doc.name ?? ''), 40)}", ${Array.isArray(nips) ? nips.length : 0} NIPs listed.`;
    },
  }),
  check({
    id: 'nip11.cors',
    spec: 'NIP-11',
    title: 'Information document is readable from web apps (CORS)',
    async run(ctx) {
      const res = await ctx.fetch(ctx.httpUrl, {
        headers: { accept: 'application/nostr+json', origin: 'https://client.example' },
      });
      expect(res.ok, `GET answered HTTP ${res.status}.`);
      await res.body?.cancel();
      const acao = res.headers.get('access-control-allow-origin');
      expect(acao, 'Missing Access-Control-Allow-Origin on the information document.');
      const pre = await ctx.fetch(ctx.httpUrl, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://client.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'accept',
        },
      });
      await pre.body?.cancel();
      expect(pre.status < 400, `CORS pre-flight (OPTIONS) answered HTTP ${pre.status}.`);
      expect(
        pre.headers.get('access-control-allow-origin'),
        'CORS pre-flight is missing Access-Control-Allow-Origin.',
      );
      return `Access-Control-Allow-Origin: ${acao}`;
    },
  }),
];

// ───────────────────────────── NIP-13 ─────────────────────────────

function mined(ctx: SuiteContext, key: Key, difficulty: number): NostrEvent {
  const base = {
    kind: 1,
    tags: [] as string[][],
    content: `pow ${token()}`,
    created_at: ctx.now(),
    pubkey: key.pk,
  };
  const m = minePow(base, difficulty);
  const ev = finalizeEvent(
    { kind: m.kind, tags: m.tags, content: m.content, created_at: m.created_at },
    key.sk,
  );
  return { ...ev };
}

const nip13: Check[] = [
  check({
    id: 'nip13.pow',
    spec: 'NIP-13',
    title: 'Proof of work is enforced as advertised',
    requiresNips: [13],
    async run(ctx) {
      const c = await ctx.connect();
      const min = Number(ctx.info?.limitation?.min_pow_difficulty ?? 0) || 0;
      if (min > 22) skip(`Required difficulty ${min} is too expensive to mine in a test.`);
      if (min > 0) {
        const plain = ctx.sign(ctx.key(), { kind: 1, content: token() });
        const why = await mustRefuse(c, plain, `a note without proof of work (min ${min})`);
        mustHavePrefix(why, ['pow']);
      }
      const d = Math.max(min, 8);
      await mustAccept(c, mined(ctx, ctx.key(), d), `a note with ${d} bits of work`);
      return min > 0
        ? `Notes below ${min} bits refused with "pow:", mined note accepted.`
        : `No minimum; a ${d}-bit note was accepted.`;
    },
  }),
];

// ─────────────────────────── NIP-17 / 59 ───────────────────────────

const nip59: Check[] = [
  check({
    id: 'nip59.giftwrap-auth',
    spec: 'NIP-17/59',
    title: 'Private messages (gift wraps) are only served to their recipient',
    requiresNips: [17, 59],
    async run(ctx) {
      const sender = ctx.key();
      const recipient = ctx.key();
      const stranger = ctx.key();
      const wrap = wrapEvent(
        { kind: 14, content: `hi ${token()}`, tags: [['p', recipient.pk]] },
        sender.sk,
        recipient.pk,
      ) as unknown as NostrEvent;
      const pubc = await ctx.connect();
      const r = await pubc.publish({ ...wrap });
      expect(r, 'No OK for a gift wrap.');
      if (!r.accepted && /^auth-required:/.test(r.message)) {
        await mustAuth(ctx, pubc, sender);
        await mustAccept(pubc, { ...wrap }, 'a gift wrap after signing in');
      } else {
        expect(r.accepted, `The relay refused a gift wrap: "${short(r.message)}".`);
      }
      const filter = { kinds: [1059], '#p': [recipient.pk] };

      const anon = await ctx.connect();
      const a = await anon.req([filter]);
      expect(!a.timedOut, 'No answer to an anonymous gift-wrap query.');
      expect(
        !a.events.some((e) => e.id === wrap.id),
        'The gift wrap was served to an anonymous reader.',
      );

      const other = await ctx.connect();
      await mustAuth(ctx, other, stranger);
      const o = await other.req([filter]);
      expect(
        !o.events.some((e) => e.id === wrap.id),
        'The gift wrap was served to a signed-in stranger.',
      );

      const mine = await ctx.connect();
      await mustAuth(ctx, mine, recipient);
      const m = await mine.req([filter]);
      expect(!m.timedOut, 'No answer to the recipient.');
      expect(m.closed === undefined, `The recipient's query was refused: "${m.closed}".`);
      expect(
        m.events.some((e) => e.id === wrap.id),
        'The signed-in recipient did not get their gift wrap.',
      );
      return 'Hidden from anonymous readers and strangers; delivered to the recipient.';
    },
  }),
];

// ───────────────────────────── NIP-29 ─────────────────────────────

const nip29: Check[] = [
  check({
    id: 'nip29.metadata-signed-by-relay',
    spec: 'NIP-29',
    title: 'Group metadata is signed by the relay',
    requiresNips: [29],
    async run(ctx) {
      const relayPk = ctx.info?.self ?? ctx.info?.pubkey;
      if (typeof relayPk !== 'string') fail('NIP-29 relays must publish their pubkey in NIP-11.');
      const c = await ctx.connect();
      const evs = await query(c, [{ kinds: [39000, 39001, 39002, 39003], limit: 50 }]);
      if (evs.length === 0) return 'No groups are visible; nothing to verify.';
      const bad = evs.filter((e) => e.pubkey !== relayPk);
      expect(bad.length === 0, `${bad.length} group metadata event(s) not signed by the relay.`);
      return `${evs.length} metadata event(s), all signed by the relay.`;
    },
  }),
  check({
    id: 'nip29.unknown-group',
    spec: 'NIP-29',
    title: 'Posts to a group that does not exist are refused',
    requiresNips: [29],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      await authenticate(ctx, c, k).catch(() => undefined);
      const ev = ctx.sign(k, { kind: 9, content: token(), tags: [['h', `nope-${token(8)}`]] });
      const why = await mustRefuse(c, ev, 'a chat message to a non-existent group');
      return `Refused with "${short(why)}".`;
    },
  }),
];

// ───────────────────────────── NIP-40 ─────────────────────────────

const nip40: Check[] = [
  check({
    id: 'nip40.already-expired',
    spec: 'NIP-40',
    title: 'Already expired events are not served',
    requiresNips: [40],
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), {
        kind: 1,
        content: token(),
        tags: [['expiration', String(ctx.now() - 60)]],
      });
      const r = await c.publish(ev);
      expect(r, 'No OK for an expired note.');
      const got = await query(c, [{ ids: [ev.id] }]);
      expect(got.length === 0, 'An already-expired note is served.');
      return r.accepted ? 'Accepted but not served.' : `Refused: "${short(r.message)}".`;
    },
  }),
  check({
    id: 'nip40.expires',
    spec: 'NIP-40',
    title: 'Events stop being served once they expire',
    requiresNips: [40],
    async run(ctx) {
      const c = await ctx.connect();
      const exp = ctx.now() + 2;
      const ev = ctx.sign(ctx.key(), {
        kind: 1,
        content: token(),
        tags: [['expiration', String(exp)]],
      });
      await mustAccept(c, ev, 'a note that expires in 2 seconds');
      const before = await query(c, [{ ids: [ev.id] }]);
      expect(before.length === 1, 'The note was not served before it expired.');
      const waitMs = (exp + 1) * 1000 - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      const after = await query(c, [{ ids: [ev.id] }]);
      expect(after.length === 0, 'The note is still served after its expiration time.');
      return 'Served before expiry, hidden after.';
    },
  }),
];

// ───────────────────────────── NIP-42 ─────────────────────────────

const nip42: Check[] = [
  check({
    id: 'nip42.challenge',
    spec: 'NIP-42',
    title: 'Sends a sign-in challenge',
    requiresNips: [42],
    async run(ctx) {
      const c = await ctx.connect();
      const ch = await c.challenge();
      expect(ch, 'No ["AUTH", <challenge>] message was received after connecting.');
      expect(ch.length >= 8, `The challenge "${ch}" is too short to be unpredictable.`);
      return 'Challenge received.';
    },
  }),
  check({
    id: 'nip42.auth-ok',
    spec: 'NIP-42',
    title: 'Accepts a correct sign-in',
    requiresNips: [42],
    async run(ctx) {
      const c = await ctx.connect();
      const r = await authenticate(ctx, c, ctx.key());
      expect(r.accepted, `A correct AUTH was refused: "${short(r.message)}".`);
      return 'AUTH accepted.';
    },
  }),
  check({
    id: 'nip42.auth-wrong-challenge',
    spec: 'NIP-42',
    title: 'Refuses a sign-in with the wrong challenge',
    requiresNips: [42],
    async run(ctx) {
      const c = await ctx.connect();
      const r = await authenticate(ctx, c, ctx.key(), { challenge: randomHex(16) });
      expect(!r.accepted, 'AUTH with a made-up challenge was accepted.');
      return `Refused: "${short(r.message)}".`;
    },
  }),
  check({
    id: 'nip42.auth-wrong-relay',
    spec: 'NIP-42',
    title: 'Refuses a sign-in meant for another relay',
    requiresNips: [42],
    async run(ctx) {
      const c = await ctx.connect();
      const r = await authenticate(ctx, c, ctx.key(), {
        relay: `wss://other-${token(6)}.invalid/`,
      });
      expect(!r.accepted, 'AUTH naming a different relay URL was accepted.');
      return `Refused: "${short(r.message)}".`;
    },
  }),
  check({
    id: 'nip42.auth-not-event',
    spec: 'NIP-42',
    title: 'Sign-in events sent as EVENT are not stored',
    requiresNips: [42],
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), {
        kind: 22242,
        tags: [
          ['relay', ctx.relayUrl],
          ['challenge', 'x'],
        ],
      });
      await c.publish(ev);
      const got = await query(c, [{ ids: [ev.id] }]);
      expect(got.length === 0, 'A kind 22242 sign-in event was stored and served.');
      return 'Not stored.';
    },
  }),
];

// ───────────────────────────── NIP-45 ─────────────────────────────

const nip45: Check[] = [
  check({
    id: 'nip45.count',
    spec: 'NIP-45',
    title: 'Counts matching events',
    requiresNips: [45],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      for (let i = 0; i < 3; i++)
        await mustAccept(c, ctx.sign(k, { kind: 1, content: token() }), 'a note');
      await mustAccept(c, ctx.sign(k, { kind: 7, content: '+' }), 'a reaction');
      const r = await c.count([{ authors: [k.pk], kinds: [1] }]);
      expect(!r.timedOut, 'No COUNT answer.');
      expect(r.closed === undefined, `COUNT refused: "${short(r.closed ?? '')}".`);
      expect(r.count !== undefined, 'COUNT answer has no numeric "count".');
      if (r.approximate) expect(r.count >= 3, `Approximate count ${r.count} is below 3.`);
      else expect(r.count === 3, `Expected count 3, got ${r.count}.`);
      const both = await c.count([{ authors: [k.pk], kinds: [1] }, { authors: [k.pk] }]);
      expect(both.count === 4 || both.approximate, `Multi-filter count gave ${both.count}, not 4.`);
      return `count=${r.count}${r.approximate ? ' (approximate)' : ''}.`;
    },
  }),
  check({
    id: 'nip45.count-giftwrap-private',
    spec: 'NIP-45',
    title: 'Counts never include private messages addressed to someone else',
    requiresNips: [45],
    async run(ctx) {
      const recipient = ctx.key();
      const stranger = ctx.key();
      const wrap = wrapEvent(
        { kind: 14, content: `hi ${token()}`, tags: [['p', recipient.pk]] },
        ctx.key().sk,
        recipient.pk,
      ) as unknown as NostrEvent;
      const pubc = await ctx.connect();
      const r = await pubc.publish({ ...wrap });
      expect(r, 'No OK for a gift wrap.');
      if (!r.accepted) skip(`The relay does not store gift wraps here: "${short(r.message)}".`);
      // The fresh recipient key has exactly one event addressed to it: the wrap.
      const leaks = (n: { count?: number; closed?: string }) =>
        n.closed === undefined && (n.count ?? 0) > 0;
      const anon = await ctx.connect();
      const a1 = await anon.count([{ '#p': [recipient.pk] }]);
      expect(!a1.timedOut, 'No COUNT answer.');
      expect(
        !leaks(a1),
        `An anonymous COUNT without kinds counted ${a1.count} private message(s).`,
      );
      const a2 = await anon.count([{ kinds: [1059], '#p': [recipient.pk] }]);
      expect(!leaks(a2), `An anonymous COUNT of gift wraps counted ${a2.count} message(s).`);
      const other = await ctx.connect();
      await mustAuth(ctx, other, stranger);
      const o1 = await other.count([{ '#p': [recipient.pk] }]);
      expect(!leaks(o1), `A signed-in stranger counted ${o1.count} private message(s).`);
      const o2 = await other.count([{ kinds: [1059], '#p': [recipient.pk] }]);
      expect(!leaks(o2), `A signed-in stranger counted ${o2.count} gift wrap(s).`);
      const mine = await ctx.connect();
      await mustAuth(ctx, mine, recipient);
      const m = await mine.count([{ kinds: [1059], '#p': [recipient.pk] }]);
      expect(!m.timedOut, 'No COUNT answer for the recipient.');
      expect(
        m.closed !== undefined || (m.count ?? 0) >= 1,
        `The recipient's own count is ${m.count}.`,
      );
      return 'Anonymous readers and strangers count 0; the recipient counts their message.';
    },
  }),
  check({
    id: 'nip45.count-private-group',
    spec: 'NIP-45',
    title: 'Counts never include posts in private groups for non-members',
    requiresNips: [45],
    async run(ctx) {
      if (!ctx.nips.has(29)) skip('The relay does not advertise NIP-29 groups.');
      const admin = ctx.key();
      const c = await ctx.connect();
      await authenticate(ctx, c, admin).catch(() => undefined);
      const id = `conf-${token(10)}`;
      const created = await c.publish(
        ctx.sign(admin, { kind: 9007, tags: [['h', id], ['private']] }),
      );
      expect(created, 'No OK for a create-group request.');
      if (!created.accepted)
        skip(`Creating a private group is not allowed here: "${short(created.message)}".`);
      for (let i = 0; i < 2; i++)
        await mustAccept(
          c,
          ctx.sign(admin, { kind: 9, content: token(), tags: [['h', id]] }),
          'a post in the private group',
        );
      // Every event by this fresh key is in the private group.
      const leaks = (n: { count?: number; closed?: string }) =>
        n.closed === undefined && (n.count ?? 0) > 0;
      const anon = await ctx.connect();
      const a = await anon.count([{ authors: [admin.pk] }]);
      expect(!a.timedOut, 'No COUNT answer.');
      expect(!leaks(a), `An anonymous COUNT counted ${a.count} private group post(s).`);
      const outsider = await ctx.connect();
      await mustAuth(ctx, outsider, ctx.key());
      const o = await outsider.count([{ authors: [admin.pk], kinds: [9] }]);
      expect(!leaks(o), `A signed-in non-member counted ${o.count} private group post(s).`);
      const m = await c.count([{ authors: [admin.pk], kinds: [9] }]);
      expect(
        m.closed !== undefined || m.approximate || m.count === 2,
        `A member's count is ${m.count}, expected 2.`,
      );
      return 'Non-members count 0; members count the posts.';
    },
  }),
];

// ───────────────────────────── NIP-50 ─────────────────────────────

const nip50: Check[] = [
  check({
    id: 'nip50.search',
    spec: 'NIP-50',
    title: 'Full-text search finds matching notes',
    requiresNips: [50],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const word = token(10);
      const hit = ctx.sign(k, { kind: 1, content: `hello ${word} world` });
      const miss = ctx.sign(k, { kind: 1, content: `nothing to see ${token(10)}` });
      await mustAccept(c, hit, 'a note');
      await mustAccept(c, miss, 'a note');
      let got: NostrEvent[] = [];
      for (let i = 0; i < 4; i++) {
        got = await query(c, [{ search: word, authors: [k.pk] }]);
        if (got.length) break;
        await sleep(500); // indexes may be asynchronous
      }
      expect(
        got.some((e) => e.id === hit.id),
        'Search did not find the matching note.',
      );
      expect(!got.some((e) => e.id === miss.id), 'Search returned a note without the word.');
      return 'Found the note containing the word, and only it.';
    },
  }),
];

// ───────────────────────────── NIP-62 ─────────────────────────────

const nip62: Check[] = [
  check({
    id: 'nip62.vanish',
    spec: 'NIP-62',
    title: 'Right to vanish removes everything from a key',
    requiresNips: [62],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const now = ctx.now();
      const old = ctx.sign(k, { kind: 1, content: token(), created_at: now - 30 });
      await mustAccept(c, old, 'a note');
      await mustAccept(
        c,
        ctx.sign(k, { kind: 0, content: '{}', created_at: now - 20 }),
        'a profile',
      );
      const req = ctx.sign(k, {
        kind: 62,
        content: 'conformance test',
        tags: [['relay', ctx.relayUrl]],
        created_at: now - 10,
      });
      await mustAccept(c, req, 'a request to vanish');
      const got = await query(c, [{ authors: [k.pk], kinds: [0, 1] }]);
      expect(got.length === 0, `${got.length} event(s) still served after vanishing.`);
      await c.publish(old);
      const back = await query(c, [{ ids: [old.id] }]);
      expect(back.length === 0, 'An event from before the vanish request was re-accepted.');
      return 'All earlier events gone and stay gone.';
    },
  }),
  check({
    id: 'nip62.other-relay',
    spec: 'NIP-62',
    title: 'Vanish requests for another relay are not applied',
    requiresNips: [62],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const note = ctx.sign(k, { kind: 1, content: token(), created_at: ctx.now() - 5 });
      await mustAccept(c, note, 'a note');
      await c.publish(
        ctx.sign(k, { kind: 62, tags: [['relay', `wss://other-${token(6)}.invalid`]] }),
      );
      const got = await query(c, [{ ids: [note.id] }]);
      expect(got.length === 1, 'A vanish request naming another relay deleted data here.');
      return 'Ignored.';
    },
  }),
];

// ───────────────────────────── NIP-65 ─────────────────────────────

const nip65: Check[] = [
  check({
    id: 'nip65.relay-list',
    spec: 'NIP-65',
    title: 'Stores and serves relay lists (kind 10002)',
    requiresNips: [65],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const ev = ctx.sign(k, {
        kind: 10002,
        tags: [
          ['r', 'wss://read.example', 'read'],
          ['r', 'wss://both.example'],
        ],
      });
      await mustAccept(c, ev, 'a relay list');
      const got = await query(c, [{ kinds: [10002], authors: [k.pk] }]);
      expect(sameSet(ids(got), [ev.id]), 'The relay list could not be read back.');
      return 'Relay list stored and served.';
    },
  }),
];

// ───────────────────────────── NIP-70 ─────────────────────────────

const nip70: Check[] = [
  check({
    id: 'nip70.protected-anon',
    spec: 'NIP-70',
    title: 'Protected events are refused without sign-in',
    requiresNips: [70],
    async run(ctx) {
      const c = await ctx.connect();
      const ev = ctx.sign(ctx.key(), { kind: 1, content: token(), tags: [['-']] });
      const why = await mustRefuse(c, ev, 'a protected note from a signed-out client');
      mustHavePrefix(why, ['auth-required', 'restricted', 'blocked']);
      return `Refused with "${short(why)}".`;
    },
  }),
  check({
    id: 'nip70.protected-author',
    spec: 'NIP-70',
    title: 'Protected events are accepted from their signed-in author only',
    requiresNips: [70],
    async run(ctx) {
      const author = ctx.key();
      const ev = ctx.sign(author, { kind: 1, content: token(), tags: [['-']] });
      const other = await ctx.connect();
      await mustAuth(ctx, other, ctx.key());
      await mustRefuse(other, ev, 'a protected note from a different signed-in key');
      const c = await ctx.connect();
      await mustAuth(ctx, c, author);
      await mustAccept(c, ev, 'a protected note from its signed-in author');
      return 'Only the signed-in author could publish it.';
    },
  }),
];

// ───────────────────────────── NIP-77 ─────────────────────────────

const nip77: Check[] = [
  check({
    id: 'nip77.negentropy',
    spec: 'NIP-77',
    title: 'Negentropy sync finds exactly the missing events',
    requiresNips: [77],
    async run(ctx) {
      const c = await ctx.connect();
      const k = ctx.key();
      const now = ctx.now();
      const evs = Array.from({ length: 6 }, (_, i) =>
        ctx.sign(k, { kind: 1, content: token(), created_at: now - 60 + i }),
      );
      for (const e of evs) await mustAccept(c, e, 'a note');
      const shared = evs.slice(0, 3);
      const relayOnly = evs.slice(3);
      const clientOnly = [0, 1].map((i) => ({ id: randomHex(), created_at: now - 30 + i }));
      const storage = new NegentropyStorageVector();
      for (const e of [...shared, ...clientOnly]) storage.insert(e.created_at, e.id);
      storage.seal();
      const neg = new Negentropy(storage, 0);
      let msg: string | null = await neg.initiate();
      const subId = c.subId('neg');
      const have: string[] = [];
      const need: string[] = [];
      let first = true;
      for (let round = 0; msg !== null; round++) {
        if (round > 20) fail('Sync did not converge within 20 rounds.');
        const from = c.mark();
        c.send(first ? ['NEG-OPEN', subId, { authors: [k.pk] }, msg] : ['NEG-MSG', subId, msg]);
        first = false;
        const f = await c.waitFor(
          (x) => (x[0] === 'NEG-MSG' || x[0] === 'NEG-ERR') && x[1] === subId,
          from,
        );
        expect(f, 'No NEG-MSG answer from the relay.');
        if (f[0] === 'NEG-ERR') fail(`The relay answered NEG-ERR: "${short(String(f[2]))}".`);
        const [next, h, n] = await neg.reconcile(String(f[2]));
        have.push(...h);
        need.push(...n);
        msg = next;
      }
      c.send(['NEG-CLOSE', subId]);
      expect(
        sameSet(need, ids(relayOnly)),
        `Expected to learn of ${relayOnly.length} missing events, got ${need.length}.`,
      );
      expect(
        sameSet(
          have,
          clientOnly.map((e) => e.id),
        ),
        `Expected ${clientOnly.length} client-only ids, got ${have.length}.`,
      );
      return `Reconciled: need ${need.length}, have ${have.length}.`;
    },
  }),
];

export const nipChecks: Check[] = [
  ...nip09,
  ...nip11,
  ...nip13,
  ...nip59,
  ...nip29,
  ...nip40,
  ...nip42,
  ...nip45,
  ...nip50,
  ...nip62,
  ...nip65,
  ...nip70,
  ...nip77,
];
