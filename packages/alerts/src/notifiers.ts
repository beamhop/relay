// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notifiers implementing core `Notifier`. All are fetch-based (Workers-safe)
 * except the optional SMTP transport, which is Bun-only and dynamically imported.
 *
 * Recipient meaning per channel:
 * - telegram: chat id · discord/slack: webhook URL · email: address
 * - nostr-dm: hex pubkey or npub · webpush: admin principal id, or `*` for all subscriptions
 */
import type { DocStore, Kernel, NostrEvent, Notification, Notifier, RelayId } from '@beamhop/core';
import { finalizeEvent, getPublicKey } from '@beamhop/core';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { wrapEvent } from 'nostr-tools/nip17';
import { decode as nip19decode } from 'nostr-tools/nip19';
import {
  type PushSubscriptionData,
  type VapidKeys,
  buildPushRequest,
  generateVapidKeys,
} from './webpush.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ICON: Record<Notification['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};
const COLOR: Record<Notification['severity'], number> = {
  info: 0x3b82f6,
  warning: 0xf59e0b,
  critical: 0xdc2626,
};

export function plainText(n: Notification): string {
  return `${n.title}\n\n${n.body}${n.url ? `\n\n${n.url}` : ''}`;
}

async function check(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`${what} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }
}

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram';
  constructor(
    private fetchFn: FetchLike,
    private botToken: string,
    private apiBase = 'https://api.telegram.org',
  ) {}
  async send(n: Notification, chatId: string): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${ICON[n.severity]} ${plainText(n)}`,
        disable_web_page_preview: true,
      }),
    });
    await check(res, 'Telegram');
  }
}

export class DiscordNotifier implements Notifier {
  readonly channel = 'discord';
  constructor(private fetchFn: FetchLike) {}
  async send(n: Notification, webhookUrl: string): Promise<void> {
    const embed: Record<string, unknown> = {
      title: `${ICON[n.severity]} ${n.title}`.slice(0, 256),
      description: n.body.slice(0, 4000),
      color: COLOR[n.severity],
    };
    if (n.url) embed.url = n.url;
    const res = await this.fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Beamhop',
        embeds: [embed],
        allowed_mentions: { parse: [] },
      }),
    });
    await check(res, 'Discord');
  }
}

export class SlackNotifier implements Notifier {
  readonly channel = 'slack';
  constructor(private fetchFn: FetchLike) {}
  async send(n: Notification, webhookUrl: string): Promise<void> {
    const blocks: unknown[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${ICON[n.severity]} ${escapeSlack(n.title)}*\n${escapeSlack(n.body)}`,
        },
      },
    ];
    if (n.url)
      blocks.push({
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open' }, url: n.url }],
      });
    const res = await this.fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${n.title}: ${n.body}`, blocks }),
    });
    await check(res, 'Slack');
  }
}

function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ───────────────────────────── Email ─────────────────────────────

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Adapter interface: any HTTP email API or SMTP. */
export interface EmailTransport {
  send(m: EmailMessage): Promise<void>;
}

/**
 * Generic HTTP email API (Resend/Postmark-style JSON). The API key may be given
 * as the URL password: `https://:KEY@api.resend.com/emails` → `Authorization: Bearer KEY`.
 */
export class HttpEmailTransport implements EmailTransport {
  private url: string;
  private apiKey: string | undefined;
  constructor(
    private fetchFn: FetchLike,
    url: string,
    apiKey?: string,
  ) {
    const u = new URL(url);
    this.apiKey = apiKey ?? (u.password ? decodeURIComponent(u.password) : undefined);
    u.username = '';
    u.password = '';
    this.url = u.toString();
  }
  async send(m: EmailMessage): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: m.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
      }),
    });
    await check(res, 'Email API');
  }
}

interface NodemailerLike {
  createTransport(url: string): { sendMail(m: EmailMessage): Promise<unknown> };
}

/** SMTP via optional `nodemailer` — Bun/Node only; dynamically imported on first use. */
export class SmtpEmailTransport implements EmailTransport {
  private transport: { sendMail(m: EmailMessage): Promise<unknown> } | null = null;
  constructor(
    private smtpUrl: string,
    private load: () => Promise<NodemailerLike> = loadNodemailer,
  ) {}
  async send(m: EmailMessage): Promise<void> {
    if (!this.transport) this.transport = (await this.load()).createTransport(this.smtpUrl);
    await this.transport.sendMail(m);
  }
}

async function loadNodemailer(): Promise<NodemailerLike> {
  const spec = 'nodemailer';
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as {
      default?: NodemailerLike;
    } & NodemailerLike;
    return mod.default ?? mod;
  } catch {
    throw new Error(
      'SMTP email needs the optional "nodemailer" package (Bun only). Use an HTTP email API URL on Cloudflare.',
    );
  }
}

export function emailTransportFor(url: string, fetchFn: FetchLike): EmailTransport {
  const scheme = url.split(':')[0]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') return new HttpEmailTransport(fetchFn, url);
  if (scheme === 'smtp' || scheme === 'smtps') return new SmtpEmailTransport(url);
  throw new Error(`unsupported email URL scheme: ${scheme}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class EmailNotifier implements Notifier {
  readonly channel = 'email';
  constructor(
    private transport: EmailTransport,
    private from: string,
  ) {}
  async send(n: Notification, to: string): Promise<void> {
    const prefix =
      n.severity === 'critical' ? '[Urgent] ' : n.severity === 'warning' ? '[Attention] ' : '';
    const html = `<h2>${escapeHtml(n.title)}</h2>${n.body
      .split('\n')
      .map((l) => `<p>${escapeHtml(l)}</p>`)
      .join('')}${n.url ? `<p><a href="${escapeHtml(n.url)}">Open</a></p>` : ''}`;
    await this.transport.send({
      from: this.from,
      to,
      subject: `${prefix}${n.title}`,
      text: plainText(n),
      html,
    });
  }
}

// ───────────────────────────── Keys & subscriptions ─────────────────────────────

export const KEYS_COLLECTION = 'alerts.keys';
export const PUSH_COLLECTION = 'alerts.push';

export async function vapidKeys(docs: DocStore): Promise<VapidKeys> {
  const existing = await docs.get<VapidKeys>(KEYS_COLLECTION, 'vapid');
  if (existing) return existing;
  const fresh = await generateVapidKeys();
  // Concurrency: first writer wins.
  if (await docs.cas(KEYS_COLLECTION, 'vapid', null, fresh)) return fresh;
  return (await docs.get<VapidKeys>(KEYS_COLLECTION, 'vapid')) as VapidKeys;
}

interface StoredNostrKey {
  sk?: string;
  /** base64 of keyWrapper-wrapped secret key. */
  wrapped?: string;
  provider?: string;
}

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Relay-owned Nostr key used to send DMs (wrapped with the KeyWrapper port when present). */
export async function relayNostrKey(kernel: Kernel): Promise<{ sk: string; pk: string }> {
  const { docs, keyWrapper } = kernel.ports;
  let stored = await docs.get<StoredNostrKey>(KEYS_COLLECTION, 'nostr');
  if (!stored) {
    const sk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const next: StoredNostrKey = keyWrapper
      ? { wrapped: toB64(await keyWrapper.wrap(hexToBytes(sk))), provider: keyWrapper.provider }
      : { sk };
    if (!(await docs.cas(KEYS_COLLECTION, 'nostr', null, next)))
      stored = await docs.get<StoredNostrKey>(KEYS_COLLECTION, 'nostr');
    else stored = next;
  }
  if (!stored) throw new Error('relay key unavailable');
  let sk = stored.sk;
  if (!sk && stored.wrapped) {
    if (!keyWrapper) throw new Error('relay key is wrapped but no key wrapper is configured');
    sk = bytesToHex(await keyWrapper.unwrap(fromB64(stored.wrapped)));
  }
  if (!sk) throw new Error('relay key unavailable');
  return { sk, pk: getPublicKey(sk) };
}

export function toHexPubkey(p: string): string {
  if (/^[0-9a-f]{64}$/.test(p)) return p;
  const d = nip19decode(p);
  if (d.type === 'npub') return d.data;
  if (d.type === 'nprofile') return d.data.pubkey;
  throw new Error('expected a hex pubkey or npub');
}

export interface PushSubscriptionRecord extends PushSubscriptionData {
  principalId: string;
  createdAt: number;
}

export async function pushKey(
  crypto_: { sha256Hex(d: Uint8Array): Promise<string> },
  principalId: string,
  endpoint: string,
) {
  const h = await crypto_.sha256Hex(new TextEncoder().encode(endpoint));
  return `${principalId}:${h.slice(0, 24)}`;
}

export class WebPushNotifier implements Notifier {
  readonly channel = 'webpush';
  constructor(
    private kernel: Kernel,
    private fetchFn: FetchLike,
    private subject: () => string,
  ) {}

  async send(n: Notification, recipient: string): Promise<void> {
    const docs = this.kernel.ports.docs;
    const subs: Array<{ key: string; value: PushSubscriptionRecord }> = [];
    let cursor: string | undefined;
    do {
      const page = await docs.list<PushSubscriptionRecord>(PUSH_COLLECTION, {
        ...(recipient === '*' ? {} : { prefix: `${recipient}:` }),
        cursor,
        limit: 200,
      });
      subs.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    if (subs.length === 0) return;
    const keys = await vapidKeys(docs);
    const payload = new TextEncoder().encode(
      JSON.stringify({
        title: n.title,
        body: n.body.slice(0, 1500),
        url: n.url,
        severity: n.severity,
        relayId: n.relayId,
      }),
    );
    const errors: string[] = [];
    for (const { key, value } of subs) {
      const req = await buildPushRequest(value, payload, keys, {
        ttl: n.severity === 'critical' ? 86400 : 4 * 3600,
        urgency: n.severity === 'critical' ? 'high' : 'normal',
        now: this.kernel.ports.clock.now(),
        subject: this.subject(),
      });
      try {
        const res = await this.fetchFn(req.url, req.init);
        if (res.status === 404 || res.status === 410) await docs.delete(PUSH_COLLECTION, key);
        else if (!res.ok) errors.push(`HTTP ${res.status}`);
      } catch (err) {
        errors.push(String(err));
      }
    }
    if (errors.length === subs.length) throw new Error(`web push failed: ${errors[0]}`);
  }
}

// ───────────────────────────── NIP-17 DM ─────────────────────────────

export type RelayPublisher = (url: string, event: NostrEvent) => Promise<void>;

interface EngineLike {
  broadcast?(relayId: RelayId, event: NostrEvent): void;
}

/** Publish one event to a remote relay over WebSocket (Bun + Workers), waiting for OK. */
export const websocketPublisher: RelayPublisher = (url, event) =>
  new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`timeout publishing to ${url}`));
    }, 8000);
    const done = (err?: Error) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.addEventListener('message', (m) => {
      try {
        const msg = JSON.parse(String(m.data));
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id)
          done(msg[2] ? undefined : new Error(String(msg[3] ?? 'rejected')));
      } catch {
        // ignore non-JSON
      }
    });
    ws.addEventListener('error', () => done(new Error(`could not connect to ${url}`)));
  });

/** NIP-17 private DM (kind 14 rumor → kind 13 seal → kind 1059 gift wrap). */
export class NostrDmNotifier implements Notifier {
  readonly channel = 'nostr-dm';
  constructor(
    private kernel: Kernel,
    private outbound: () => string[],
    private publish: RelayPublisher = websocketPublisher,
  ) {}

  async wrap(n: Notification, recipient: string): Promise<NostrEvent> {
    const { sk } = await relayNostrKey(this.kernel);
    return wrapEvent(
      hexToBytes(sk),
      { publicKey: toHexPubkey(recipient) },
      plainText(n),
    ) as NostrEvent;
  }

  async send(n: Notification, recipient: string): Promise<void> {
    const wrap = await this.wrap(n, recipient);
    const relays = this.kernel.config().relays;
    const relayId = n.relayId ?? relays[0]?.id;
    if (relayId) {
      await this.kernel.ports.events.save(relayId, wrap);
      this.kernel.use<EngineLike>('relay.engine')?.broadcast?.(relayId, wrap);
    }
    const urls = this.outbound();
    const results = await Promise.allSettled(urls.map((u) => this.publish(u, wrap)));
    if (!relayId && urls.length > 0 && results.every((r) => r.status === 'rejected'))
      throw new Error('could not deliver the direct message to any relay');
  }
}

/** Signed kind 0 profile for the relay's alert key (so DMs show a friendly name). */
export async function relayProfileEvent(kernel: Kernel, name: string): Promise<NostrEvent> {
  const { sk } = await relayNostrKey(kernel);
  return finalizeEvent(
    {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name, about: 'Alerts from your Beamhop relay' }),
      created_at: kernel.ports.clock.now(),
    },
    sk,
  );
}
