// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type NostrEvent, verifyEvent } from '@beamhop/core';
import type { RelayEngine } from '@beamhop/relay';
import { makeKey } from '@beamhop/testkit';
import {
  getConversationKey,
  decrypt as nip44decrypt,
  encrypt as nip44encrypt,
} from 'nostr-tools/nip44';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fromHex } from '../src/bytes.ts';
import { NIP46_KIND, keyvaultRuntime } from '../src/index.ts';
import { FakeConn, setup } from './helpers.ts';

/** Minimal SimplePool stand-in that talks to the in-process relay engine through fake sockets. */
function fakePool(engine: RelayEngine, relayId = 'main') {
  const ready: Promise<unknown>[] = [];
  let subSeq = 0;
  const pub = new FakeConn(relayId, Date.now());
  const pubOpen = engine.open(pub);
  ready.push(pubOpen);
  const pool = {
    ready,
    subscribe(
      _relays: string[],
      filter: Record<string, unknown>,
      params: { onevent?: (e: NostrEvent) => void; onclose?: (r: string[]) => void },
    ) {
      const conn = new FakeConn(relayId, Date.now());
      const subId = `s${++subSeq}`;
      conn.onFrame = (f) => {
        if (f[0] === 'EVENT' && f[1] === subId) params.onevent?.(f[2] as NostrEvent);
      };
      const p = engine
        .open(conn)
        .then(() => engine.handle(conn, JSON.stringify(['REQ', subId, filter])));
      ready.push(p);
      return {
        close: () => {
          void p.then(() => engine.handle(conn, JSON.stringify(['CLOSE', subId])));
        },
      };
    },
    publish(_relays: string[], event: NostrEvent) {
      return [
        pubOpen.then(async () => {
          const before = pub.frames.length;
          await engine.handle(pub, JSON.stringify(['EVENT', event]));
          const ok = pub.frames.slice(before).find((f) => f[0] === 'OK');
          if (!ok?.[2]) throw new Error(`rejected: ${JSON.stringify(ok)}`);
          return 'ok';
        }),
      ];
    },
  };
  return pool;
}

async function connectSigner(engine: RelayEngine, url: string) {
  const bp = await parseBunkerInput(url);
  if (!bp) throw new Error('bad bunker url');
  const pool = fakePool(engine);
  const clientSk = generateSecretKey();
  const signer = BunkerSigner.fromBunker(clientSk, bp, { pool: pool as never });
  await Promise.all(pool.ready);
  return { signer, clientSk, bp, pool };
}

async function withTimeout<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

describe('NIP-46 bunker hosted by the relay', () => {
  test('full flow with nostr-tools BunkerSigner: connect, pubkey, sign, nip44, ping', async () => {
    const h = await setup({ withRelay: true, realtimeClock: true });
    const userPk = await h.svc.ensureKey('google:alice');
    const url = await h.svc.bunkerUrlFor('sess-1', 'google:alice');
    const bunkerPk = await h.svc.bunkerPubkey();
    expect(url).toMatch(
      new RegExp(`^bunker://${bunkerPk}\\?relay=wss%3A%2F%2Frelay\\.test&secret=[0-9a-f]{32}$`),
    );

    const { signer } = await connectSigner(h.engine!, url);
    await withTimeout(signer.connect({ name: 'Team client' }));
    expect(await withTimeout(signer.getPublicKey())).toBe(userPk);
    await withTimeout(signer.ping());

    const signed = await withTimeout(
      signer.signEvent({
        kind: 1,
        content: 'hello from the bunker',
        tags: [],
        created_at: h.clock.now(),
      }),
    );
    expect(signed.pubkey).toBe(userPk);
    expect(verifyEvent(signed as NostrEvent)).toBe(true);

    const bob = makeKey();
    const ct = await withTimeout(signer.nip44Encrypt(bob.pk, 'secret'));
    expect(nip44decrypt(ct, getConversationKey(fromHex(bob.sk), userPk))).toBe('secret');
    const toAlice = nip44encrypt('reply', getConversationKey(fromHex(bob.sk), userPk));
    expect(await withTimeout(signer.nip44Decrypt(bob.pk, toAlice))).toBe('reply');
    await expect(withTimeout(signer.nip04Encrypt(bob.pk, 'x'))).rejects.toMatch(/NIP-44/);

    // Signing is audited with the session and client name.
    const audit = await keyvaultRuntime(h.kernel)!.signer.listAudit({ op: 'sign' });
    expect(audit[0]).toMatchObject({
      subjectId: 'google:alice',
      kind: 1,
      sessionId: 'sess-1',
      client: 'Team client',
      via: 'bunker',
      ok: true,
    });
    // Responses are ephemeral: never stored.
    expect(await h.ports.events.query('main', [{ kinds: [NIP46_KIND] }])).toHaveLength(0);
    await signer.close();
  });

  test('secrets are one-time; unknown clients are refused', async () => {
    const h = await setup({ withRelay: true, realtimeClock: true });
    await h.svc.ensureKey('google:alice');
    const url = await h.svc.bunkerUrlFor('sess-1', 'google:alice');
    const a = await connectSigner(h.engine!, url);
    await withTimeout(a.signer.connect());
    const b = await connectSigner(h.engine!, url);
    await expect(withTimeout(b.signer.connect())).rejects.toMatch(/invalid or used secret/);
    await expect(withTimeout(b.signer.getPublicKey())).rejects.toMatch(/connect first/);
  });

  test('offboarding revokes sessions; an ended SSO session stops signing', async () => {
    const sessions = [{ sid: 'sess-1', expiresAt: Math.floor(Date.now() / 1000) + 3600 }];
    const h = await setup({ withRelay: true, realtimeClock: true });
    h.kernel.provide('enterprise.identity', {
      sessions: { list: async (key: string) => (key === 'google:alice' ? sessions : []) },
    });
    await h.svc.ensureKey('google:alice');
    const { signer } = await connectSigner(
      h.engine!,
      await h.svc.bunkerUrlFor('sess-1', 'google:alice'),
    );
    await withTimeout(signer.connect());
    await withTimeout(
      signer.signEvent({ kind: 1, content: 'a', tags: [], created_at: h.clock.now() }),
    );

    sessions.length = 0; // SSO session ended
    await expect(
      withTimeout(signer.signEvent({ kind: 1, content: 'b', tags: [], created_at: h.clock.now() })),
    ).rejects.toMatch(/sign-in has ended/);
    sessions.push({ sid: 'sess-1', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await withTimeout(signer.getPublicKey());

    await h.svc.revokeSessions('google:alice');
    await expect(
      withTimeout(signer.signEvent({ kind: 1, content: 'c', tags: [], created_at: h.clock.now() })),
    ).rejects.toMatch(/connect first/);
    await expect(h.svc.bunkerUrlFor('sess-1')).rejects.toThrow(/signed out/);
  });

  test('per-session kind permissions and denied kinds', async () => {
    const h = await setup({
      withRelay: true,
      realtimeClock: true,
      keyvault: { bunker: { deniedKinds: [0] } },
    });
    await h.svc.ensureKey('google:alice');
    const url = await keyvaultRuntime(h.kernel)!.bunker.bunkerUrlFor('s', 'google:alice', {
      perms: ['sign_event:1', 'sign_event:0'],
    });
    const { signer } = await connectSigner(h.engine!, url);
    await withTimeout(signer.connect());
    const t = (kind: number) => ({ kind, content: '', tags: [], created_at: h.clock.now() });
    await withTimeout(signer.signEvent(t(1)));
    await expect(withTimeout(signer.signEvent(t(7)))).rejects.toMatch(/not allowed/);
    await expect(withTimeout(signer.signEvent(t(0)))).rejects.toMatch(/kind 0 cannot be signed/);
    await expect(withTimeout(signer.nip44Encrypt(makeKey().pk, 'x'))).rejects.toMatch(
      /not allowed/,
    );
  });

  test('ignores requests for other signers and garbage content', async () => {
    const h = await setup({ withRelay: true, realtimeClock: true });
    const rt = keyvaultRuntime(h.kernel)!;
    const bunkerPk = await rt.bunker.pubkey();
    const sent: NostrEvent[] = [];
    const engine = h.engine!;
    const orig = engine.broadcast.bind(engine);
    engine.broadcast = (relayId, ev, json) => {
      if (ev.kind === NIP46_KIND && ev.pubkey === bunkerPk) sent.push(ev);
      return orig(relayId, ev, json);
    };
    const client = generateSecretKey();
    const pub = new FakeConn('main', Date.now());
    await engine.open(pub);
    const other = makeKey().pk;
    const mk = (p: string, content: string) =>
      finalizeEvent(
        { kind: NIP46_KIND, tags: [['p', p]], content, created_at: h.clock.now() },
        client,
      );
    await engine.handle(pub, JSON.stringify(['EVENT', mk(other, 'x')]));
    await engine.handle(pub, JSON.stringify(['EVENT', mk(bunkerPk, 'not encrypted')]));
    const ck = getConversationKey(client, bunkerPk);
    await engine.handle(
      pub,
      JSON.stringify([
        'EVENT',
        mk(bunkerPk, nip44encrypt(JSON.stringify({ id: '1', method: 'ping', params: [] }), ck)),
      ]),
    );
    await rt.bunker.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tags).toEqual([['p', getPublicKey(client)]]);
    expect(JSON.parse(nip44decrypt(sent[0]!.content, ck))).toEqual({ id: '1', result: 'pong' });
  });
});
