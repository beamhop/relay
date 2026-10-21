// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { NostrEvent, Notification } from '@beamhop/core';
import { createInsightsModule } from '@beamhop/insights';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { hexToBytes } from '@noble/hashes/utils';
import { unwrapEvent } from 'nostr-tools/nip17';
import { npubEncode } from 'nostr-tools/nip19';
import {
  EmailNotifier,
  HttpEmailTransport,
  SmtpEmailTransport,
  b64urlDecode,
  concat,
  digestDue,
  relayNostrKey,
} from '../src/index.ts';
import { OWNER, b64u, setup } from './helpers.ts';

const N: Notification = {
  severity: 'critical',
  title: 'Disk is almost full',
  body: 'Only 1 GB left.',
  url: 'https://relay.example.com/admin/?alert=1',
  category: 'ops',
};

const CHANNELS = [
  { type: 'telegram', id: 'tg', botToken: '123:abc', chatId: '-100' },
  { type: 'discord', id: 'dc', webhookUrl: 'https://discord.example/hook' },
  { type: 'slack', id: 'sl', webhookUrl: 'https://hooks.slack.example/T1' },
  {
    type: 'email',
    id: 'mail',
    to: 'ops@example.com',
    smtpUrl: 'https://:re_secret@api.mail.example/emails',
  },
];

describe('webhook notifiers via injected fetch', () => {
  test('Telegram, Discord, Slack and HTTP email payloads', async () => {
    const { kernel, calls } = await setup({
      config: { alerts: { channels: CHANNELS } },
      alerts: { email: { from: 'Relay <alerts@relay.example.com>' } },
    });
    await kernel.notify(N);
    const by = (host: string) => calls.find((c) => c.url.includes(host))!;

    const tg = by('api.telegram.org');
    expect(tg.url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(tg.json).toMatchObject({ chat_id: '-100', disable_web_page_preview: true });
    expect((tg.json as { text: string }).text).toContain('Disk is almost full\n\nOnly 1 GB left.');

    const dc = by('discord.example');
    expect(dc.json).toMatchObject({
      username: 'Beamhop',
      embeds: [{ description: 'Only 1 GB left.', color: 0xdc2626, url: N.url }],
      allowed_mentions: { parse: [] },
    });

    const sl = by('hooks.slack.example');
    const slack = sl.json as { text: string; blocks: Array<{ type: string }> };
    expect(slack.text).toBe('Disk is almost full: Only 1 GB left.');
    expect(slack.blocks.map((b) => b.type)).toEqual(['section', 'actions']);

    const mail = by('api.mail.example');
    expect(mail.url).toBe('https://api.mail.example/emails');
    expect((mail.init.headers as Record<string, string>).authorization).toBe('Bearer re_secret');
    expect(mail.json).toMatchObject({
      from: 'Relay <alerts@relay.example.com>',
      to: 'ops@example.com',
      subject: '[Urgent] Disk is almost full',
    });
    expect((mail.json as { html: string }).html).toContain('<h2>Disk is almost full</h2>');
  });

  test('severity gate: info is not pushed; per-channel minimum', async () => {
    const { kernel, calls } = await setup({
      config: { alerts: { channels: CHANNELS } },
      alerts: { channelSeverity: { tg: 'critical' } },
    });
    await kernel.notify({ ...N, severity: 'info' });
    expect(calls).toHaveLength(0);
    await kernel.notify({ ...N, severity: 'warning' });
    expect(calls.some((c) => c.url.includes('telegram'))).toBe(false);
    expect(calls).toHaveLength(3);
  });

  test('failed deliveries are reported, not thrown', async () => {
    const { kernel, rt } = await setup({ config: { alerts: { channels: CHANNELS } }, status: 500 });
    const errors: string[] = [];
    kernel.bus.on('error', (e) => errors.push(e.source));
    const res = await rt.route(N);
    expect(res.every((r) => !r.ok)).toBe(true);
    expect(errors).toContain('alerts.notify.discord');
  });

  test('SMTP adapter loads its transport lazily (Bun-only, optional)', async () => {
    const sent: unknown[] = [];
    const smtp = new SmtpEmailTransport('smtp://user:pass@mail.example:587', async () => ({
      createTransport: () => ({ sendMail: async (m: unknown) => void sent.push(m) }),
    }));
    await new EmailNotifier(smtp, 'a@b.c').send(N, 'ops@example.com');
    expect(sent).toHaveLength(1);
    expect(new HttpEmailTransport(fetch, 'https://x.example/send', 'k')).toBeTruthy();
  });
});

describe('on-call routing', () => {
  test('only the on-duty admin channels receive alerts; rotation advances weekly', async () => {
    const { kernel, calls, act, ports } = await setup({
      config: { alerts: { channels: CHANNELS } },
    });
    const r = await act('alerts.set-oncall', {
      rotation: [
        { principalId: 'alice', channels: ['dc'] },
        { principalId: 'bob', channels: ['sl', 'nope'] },
      ],
    });
    expect(r.preview.some((l) => l.kind === 'warning' && l.text.includes('nope'))).toBe(true);
    await kernel.notify(N);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['discord.example']);
    ports.clock.advance(7 * 86400);
    await kernel.notify(N);
    expect(new URL(calls[1]!.url).host).toBe('hooks.slack.example');
    await r.undo();
    calls.length = 0;
    await kernel.notify(N);
    expect(calls).toHaveLength(4);
  });
});

describe('NIP-17 DM', () => {
  test('gift wrap is stored locally, published outbound, and decryptable by the admin', async () => {
    const admin = makeKey();
    const published: Array<{ url: string; event: NostrEvent }> = [];
    const { kernel, ports } = await setup({
      config: {
        alerts: { channels: [{ type: 'nostr-dm', id: 'dm', pubkey: npubEncode(admin.pk) }] },
      },
      alerts: { nostrDm: { relays: ['wss://inbox.example'] } },
      options: { publish: async (url, event) => void published.push({ url, event }) },
    });
    const broadcast: NostrEvent[] = [];
    kernel.provide('relay.engine', { broadcast: (_r: string, e: NostrEvent) => broadcast.push(e) });
    await kernel.notify(N);
    const stored = await ports.events.query('main', [{ kinds: [1059], '#p': [admin.pk] }]);
    expect(stored).toHaveLength(1);
    expect(broadcast.map((e) => e.id)).toEqual([stored[0]!.id]);
    expect(published).toEqual([{ url: 'wss://inbox.example', event: stored[0]! }]);
    const rumor = unwrapEvent(stored[0]!, hexToBytes(admin.sk));
    expect(rumor.kind).toBe(14);
    expect(rumor.content).toContain('Disk is almost full');
    const relayKey = await relayNostrKey(kernel);
    expect(rumor.pubkey).toBe(relayKey.pk);
    // the relay key is stable
    expect((await relayNostrKey(kernel)).sk).toBe(relayKey.sk);
  });

  test('relay key is wrapped when a KeyWrapper port exists', async () => {
    const { kernel, ports } = await setup();
    const xor = (d: Uint8Array) => d.map((b) => b ^ 0x5a);
    (ports as { keyWrapper?: unknown }).keyWrapper = {
      provider: 'test',
      wrap: async (d: Uint8Array) => xor(d),
      unwrap: async (d: Uint8Array) => xor(d),
    };
    const k = await relayNostrKey(kernel);
    const stored = await ports.docs.get<{ sk?: string; wrapped?: string }>('alerts.keys', 'nostr');
    expect(stored?.sk).toBeUndefined();
    expect(stored?.wrapped).toBeTruthy();
    expect((await relayNostrKey(kernel)).pk).toBe(k.pk);
  });
});

async function decryptPush(
  body: Uint8Array,
  uaPub: Uint8Array,
  uaPriv: JsonWebKey,
  auth: Uint8Array,
) {
  const enc = new TextEncoder();
  const hmac = async (key: Uint8Array, data: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
          'raw',
          new Uint8Array(key),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        ),
        new Uint8Array(data),
      ),
    );
  const salt = body.slice(0, 16);
  const asPub = body.slice(21, 21 + body[20]!);
  const priv = await crypto.subtle.importKey(
    'jwk',
    uaPriv,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const pub = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(asPub),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256),
  );
  const ikm = await hmac(
    await hmac(auth, secret),
    concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])),
  );
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))
  ).slice(0, 16);
  const nonce = (
    await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))
  ).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      new Uint8Array(body.slice(21 + body[20]!)),
    ),
  );
  return new TextDecoder().decode(padded.slice(0, padded.lastIndexOf(2)));
}

describe('web push end to end', () => {
  test('subscribe → alert → encrypted request decryptable by the device; 410 removes it', async () => {
    const { kernel, calls, act, ports } = await setup({
      config: { alerts: { channels: [{ type: 'webpush', id: 'push' }] } },
      alerts: { vapidSubject: 'mailto:ops@example.com' },
    });
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const uaPriv = await crypto.subtle.exportKey('jwk', ua.privateKey);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const sub = await act('alerts.subscribe-push', {
      endpoint: 'https://push.example.net/wpush/abc',
      keys: { p256dh: b64u(uaPub), auth: b64u(auth) },
    });
    const out = sub.result.output as { publicKey: string; channelConfigured: boolean };
    expect(out.channelConfigured).toBe(true);
    expect(b64urlDecode(out.publicKey)).toHaveLength(65);

    await kernel.notify(N);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Urgency).toBe('high');
    expect(headers.Authorization).toContain(`k=${out.publicKey}`);
    const payload = JSON.parse(
      await decryptPush(calls[0]!.init.body as Uint8Array, uaPub, uaPriv, auth),
    );
    expect(payload).toMatchObject({ title: N.title, severity: 'critical', url: N.url });

    // other principals' subscriptions are not used when someone is on call
    await act('alerts.set-oncall', {
      rotation: [{ principalId: 'someone-else', channels: ['push'] }],
    });
    await kernel.notify(N);
    expect(calls).toHaveLength(1);
    await act('alerts.set-oncall', { rotation: [{ principalId: OWNER.id, channels: ['push'] }] });
    await kernel.notify(N);
    expect(calls).toHaveLength(2);
    const list = await ports.docs.list('alerts.push');
    expect(list.items).toHaveLength(1);
  });

  test('gone subscriptions are pruned', async () => {
    const { kernel, act, ports } = await setup({
      config: { alerts: { channels: [{ type: 'webpush', id: 'push' }] } },
      status: 410,
    });
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    await act('alerts.subscribe-push', {
      endpoint: 'https://push.example.net/x',
      keys: { p256dh: b64u(uaPub), auth: b64u(new Uint8Array(16)) },
    });
    await kernel.notify(N);
    expect((await ports.docs.list('alerts.push')).items).toHaveLength(0);
  });

  test('test-channel action delivers a test message', async () => {
    const { act, calls } = await setup({ config: { alerts: { channels: CHANNELS } } });
    const r = await act('alerts.test-channel', { channelId: 'dc' });
    expect(r.result.summary).toContain('dc');
    expect(calls).toHaveLength(1);
    await expect(act('alerts.test-channel', { channelId: 'missing' })).rejects.toThrow();
  });
});

describe('digest', () => {
  test('content: health, growth, changes, alerts, waiting cards and a tip', async () => {
    const { kernel, act, calls, minute, ports } = await setup({
      config: { alerts: { channels: [CHANNELS[1]], digest: 'weekly' } },
      modules: [createInsightsModule()],
    });
    const k = makeKey();
    for (let i = 0; i < 3; i++)
      kernel.bus.emit('event.accepted', { relayId: 'main', event: makeEvent(k), latencyMs: 2 });
    kernel.bus.emit('admin.action', {
      relayId: 'main',
      actionId: 'moderation.ban-pubkey',
      principalId: 'owner',
      input: {},
      summary: 'Banned 3 keys',
      ok: true,
    });
    await minute(0, 80); // error spike → active alert + card
    kernel.cards.push({
      id: 'test',
      cards: async () => [
        { id: 'x', relayId: null, severity: 'info', title: 'Finish setup', body: '', createdAt: 0 },
      ],
    });
    calls.length = 0;
    const r = await act('alerts.send-digest', {});
    const d = r.result.output as { title: string; body: string; tipId?: string; period: string };
    expect(d.period).toBe('weekly');
    expect(d.title).toMatch(
      /^Your relay this week: (healthy|needs a look|needs attention) \(\d+\/100\)$/,
    );
    expect(d.body).toContain('Health\nHealth score');
    expect(d.body).toContain('1 active person this week');
    expect(d.body).toContain('3 posts');
    expect(d.body).toContain('What changed\n• Banned 3 keys');
    expect(d.body).toContain('Still open: Many errors right now');
    expect(d.body).toContain('Waiting for you');
    expect(d.body).toContain('• Finish setup');
    expect(d.body).toContain('Tip\n');
    expect(calls).toHaveLength(1);
    // dismissing a tip removes it from rotation
    await act('alerts.dismiss-tip', { tipId: d.tipId });
    const again = (await act('alerts.send-digest', {})).result.output as { tipId?: string };
    expect(again.tipId).not.toBe(d.tipId);
    expect(ports.clock.now()).toBeGreaterThan(0);
  });

  test('due logic: daily at the configured hour, weekly on the weekday, catch-up', () => {
    const mon10 = Date.UTC(2026, 9, 19, 10) / 1000; // Monday
    const mon9 = mon10 - 3600;
    expect(digestDue('off', mon9, null, 9, 1)).toBe(false);
    expect(digestDue('daily', mon9, null, 9, 1)).toBe(true);
    expect(digestDue('daily', mon10, null, 9, 1)).toBe(false);
    expect(digestDue('daily', mon9 + 86400, mon9, 9, 1)).toBe(true);
    expect(digestDue('daily', mon9 + 3600, mon9, 9, 1)).toBe(false);
    expect(digestDue('weekly', mon9, null, 9, 1)).toBe(true);
    expect(digestDue('weekly', mon9 + 86400, null, 9, 1)).toBe(false);
    // missed slot (server down): catch up once overdue
    expect(digestDue('daily', mon10 + 2 * 86400, mon9, 9, 1)).toBe(true);
  });

  test('hourly job sends when due', async () => {
    const { ports, calls } = await setup({
      config: { alerts: { channels: [CHANNELS[1]], digest: 'daily' } },
    });
    ports.clock.ms = Date.UTC(2026, 9, 20, 9, 5);
    await ports.scheduler.tick('alerts.digest');
    expect(calls).toHaveLength(1);
    await ports.scheduler.tick('alerts.digest');
    expect(calls).toHaveLength(1);
  });
});
