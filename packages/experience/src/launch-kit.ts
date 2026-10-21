// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Launch kit (§7 first week): the addresses to share, a QR code, a draft
 * announcement (never published by Beamhop), NIP-11 polish suggestions, and
 * "Test my relay" — a check from the outside: connect, publish, fetch and
 * upload against the relay's own public address.
 */
import {
  type BeamhopConfig,
  type NostrEvent,
  type RelayConfig,
  type UnsignedEvent,
  finalizeEvent,
  generateSecretKey,
} from '@beamhop/core';
import { qrSvg } from '@beamhop/public-web';

// ───────────────────────────── addresses ─────────────────────────────

export interface RelayUrls {
  relay: string;
  blossom: string | null;
  landing: string;
  nip11: string;
}

export function relayUrls(cfg: BeamhopConfig, relay: RelayConfig): RelayUrls {
  const host = relay.hosts[0] ?? 'localhost';
  const secure = cfg.node.tls.mode !== 'off';
  const prefix = (relay.pathPrefix ?? '').replace(/\/+$/, '');
  const http = `${secure ? 'https' : 'http'}://${host}${prefix}`;
  return {
    relay: `${secure ? 'wss' : 'ws'}://${host}${prefix}`,
    blossom: relay.blossom.enabled ? http : null,
    landing: `${http}/`,
    nip11: http,
  };
}

// ───────────────────────────── NIP-11 polish ─────────────────────────────

export interface PolishSuggestion {
  field: 'name' | 'description' | 'icon' | 'banner' | 'contact' | 'pubkey' | 'rules';
  text: string;
  technical: string;
  /** Config path to edit (relay-relative). */
  path: string;
  importance: 'recommended' | 'nice-to-have';
}

export function nip11Polish(relay: RelayConfig): PolishSuggestion[] {
  const out: PolishSuggestion[] = [];
  const i = relay.info;
  const add = (
    field: PolishSuggestion['field'],
    text: string,
    technical: string,
    importance: PolishSuggestion['importance'] = 'recommended',
  ) => out.push({ field, text, technical, path: `info.${field}`, importance });
  if (i.name.trim() === '' || i.name === 'Beamhop Relay')
    add('name', 'Give your relay its own name', 'NIP-11 `name` is still the default');
  if (i.description.trim() === '')
    add(
      'description',
      'Add a one-line description so people know what your relay is for',
      'NIP-11 `description` is empty',
    );
  if (!i.icon)
    add('icon', 'Add an icon — apps show it next to your relay', 'NIP-11 `icon` (URL) is missing');
  if (!i.contact)
    add(
      'contact',
      'Add a way to reach you (email or website)',
      'NIP-11 `contact` is missing (URI: mailto:, https:)',
    );
  if (!i.pubkey)
    add(
      'pubkey',
      'Add your public key so people can message the operator',
      'NIP-11 `pubkey` (owner hex pubkey) is missing',
    );
  if (!i.rules && relay.persona !== 'private-team')
    add(
      'rules',
      'Write a few community rules for your landing page',
      'relay.info.rules is empty (landing page + NIP-11 `posting_policy`)',
      'nice-to-have',
    );
  if (!i.banner)
    add(
      'banner',
      'Add a banner image for your landing page',
      'NIP-11 `banner` (URL) is missing',
      'nice-to-have',
    );
  return out;
}

// ───────────────────────────── launch kit ─────────────────────────────

export interface LaunchKit {
  urls: RelayUrls;
  qr: { landing: string; relay: string };
  /** Kind 1 draft. Unsigned and never published by Beamhop — the admin posts it from their own client. */
  announcement: { draft: UnsignedEvent; published: false; text: string };
  polish: PolishSuggestion[];
}

export function announcementText(relay: RelayConfig, urls: RelayUrls): string {
  const name = relay.info.name === 'Beamhop Relay' ? 'my new relay' : relay.info.name;
  const lines = [
    `I just opened ${name} 🎉`,
    relay.info.description ? `\n${relay.info.description}` : '',
    `\nAdd it to your client: ${urls.relay}`,
    urls.blossom ? `Media server: ${urls.blossom}` : '',
    `More info: ${urls.landing}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function buildLaunchKit(
  cfg: BeamhopConfig,
  relay: RelayConfig,
  now: number,
  pubkey?: string,
): LaunchKit {
  const urls = relayUrls(cfg, relay);
  const text = announcementText(relay, urls);
  const draft: UnsignedEvent = {
    kind: 1,
    pubkey: pubkey ?? relay.info.pubkey ?? '',
    created_at: now,
    content: text,
    tags: [
      ['r', urls.relay],
      ['t', 'nostr'],
      ['t', 'relay'],
    ],
  };
  return {
    urls,
    qr: {
      landing: qrSvg(urls.landing, { label: 'Landing page' }),
      relay: qrSvg(urls.relay, { label: 'Relay address' }),
    },
    announcement: { draft, published: false, text },
    polish: nip11Polish(relay),
  };
}

// ───────────────────────────── test my relay ─────────────────────────────

/** A WebSocket as seen from the outside, reduced to what the test needs. */
export interface TestSocket {
  send(data: string): void;
  /** Next text message, or null on timeout/close. */
  receive(timeoutMs: number): Promise<string | null>;
  close(): void;
}

/**
 * How the test reaches the relay "from the outside". Injected so tests (and
 * runtimes behind NAT) can supply their own; the default uses global
 * `fetch` and `WebSocket` (Web-standard on Bun and Workers).
 */
export interface OutsideDialer {
  fetch(req: Request): Promise<Response>;
  connect(url: string, timeoutMs: number): Promise<TestSocket>;
}

export const defaultDialer: OutsideDialer = {
  fetch: (req) => fetch(req),
  connect(url, timeoutMs) {
    return new Promise<TestSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      const inbox: string[] = [];
      const waiters: Array<(m: string | null) => void> = [];
      let closed = false;
      const timer = setTimeout(() => {
        reject(new Error('connection timed out'));
        try {
          ws.close();
        } catch {}
      }, timeoutMs);
      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const w = waiters.shift();
        if (w) w(data);
        else inbox.push(data);
      };
      ws.onclose = () => {
        closed = true;
        for (const w of waiters.splice(0)) w(null);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('could not connect'));
      };
      ws.onopen = () => {
        clearTimeout(timer);
        resolve({
          send: (d) => ws.send(d),
          receive(ms) {
            const m = inbox.shift();
            if (m !== undefined) return Promise.resolve(m);
            if (closed) return Promise.resolve(null);
            return new Promise((res) => {
              const t = setTimeout(() => {
                const i = waiters.indexOf(done);
                if (i >= 0) waiters.splice(i, 1);
                res(null);
              }, ms);
              const done = (v: string | null) => {
                clearTimeout(t);
                res(v);
              };
              waiters.push(done);
            });
          },
          close: () => ws.close(),
        });
      };
    });
  },
};

export type StepStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface TestStep {
  id: 'info' | 'connect' | 'publish' | 'fetch' | 'upload' | 'download' | 'cleanup';
  title: string;
  status: StepStatus;
  /** Plain-language result. */
  message: string;
  technical?: string;
  ms: number;
}

export interface TestRelayReport {
  relayId: string;
  ok: boolean;
  /** Plain summary line. */
  summary: string;
  urls: RelayUrls;
  steps: TestStep[];
  at: number;
}

export interface TestRelayOptions {
  dialer: OutsideDialer;
  timeoutMs: number;
  nowMs: () => number;
  now: () => number;
  sha256Hex: (data: Uint8Array) => Promise<string>;
  /** Skip the Blossom upload/download round-trip. */
  skipUpload?: boolean;
}

/** Reject prefixes that mean "the relay works, it just doesn't let strangers post". */
const POLICY_PREFIXES = ['restricted', 'auth-required', 'pow', 'blocked', 'rate-limited'];

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function waitFor(
  sock: TestSocket,
  timeoutMs: number,
  match: (msg: unknown[]) => boolean,
): Promise<unknown[] | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const raw = await sock.receive(left);
    if (raw === null) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Array.isArray(msg) && match(msg)) return msg;
  }
}

export async function testRelay(
  cfg: BeamhopConfig,
  relay: RelayConfig,
  opts: TestRelayOptions,
): Promise<TestRelayReport> {
  const urls = relayUrls(cfg, relay);
  const steps: TestStep[] = [];
  const t = opts.timeoutMs;
  const step = async (
    id: TestStep['id'],
    title: string,
    fn: () => Promise<Pick<TestStep, 'status' | 'message' | 'technical'>>,
  ) => {
    const start = opts.nowMs();
    let r: Pick<TestStep, 'status' | 'message' | 'technical'>;
    try {
      r = await fn();
    } catch (err) {
      r = {
        status: 'fail',
        message: 'Something went wrong while checking.',
        technical: String(err),
      };
    }
    const s: TestStep = {
      id,
      title,
      status: r.status,
      message: r.message,
      ms: opts.nowMs() - start,
    };
    if (r.technical) s.technical = r.technical;
    steps.push(s);
    return s;
  };
  const skip = (id: TestStep['id'], title: string, message: string) =>
    steps.push({ id, title, status: 'skip', message, ms: 0 });

  // A throwaway key, so the test never uses (or needs) the owner's key.
  const sk = generateSecretKey();
  const sign = (e: Omit<UnsignedEvent, 'pubkey'>): NostrEvent => finalizeEvent(e, sk);

  // 1. Relay information document.
  await step('info', 'Relay information page', async () => {
    const res = await opts.dialer.fetch(
      new Request(urls.nip11, { headers: { accept: 'application/nostr+json' } }),
    );
    if (!res.ok)
      return {
        status: 'fail',
        message: `Your relay's address answered with an error (${res.status}).`,
        technical: `GET ${urls.nip11} (Accept: application/nostr+json) → HTTP ${res.status}`,
      };
    const doc = (await res.json().catch(() => null)) as { name?: string } | null;
    if (!doc || typeof doc !== 'object')
      return {
        status: 'warn',
        message: 'Your relay answered, but not with relay information. Is a proxy in the way?',
        technical: 'NIP-11 response was not JSON',
      };
    return {
      status: 'pass',
      message: `Found “${doc.name ?? 'unnamed relay'}” at its public address.`,
      technical: `NIP-11 OK from ${urls.nip11}`,
    };
  });

  // 2. WebSocket connection.
  const st: { sock: TestSocket | null; published: NostrEvent | null } = {
    sock: null,
    published: null,
  };
  await step('connect', 'Connect', async () => {
    st.sock = await opts.dialer.connect(urls.relay, t);
    return {
      status: 'pass',
      message: 'Apps can connect to your relay.',
      technical: `WebSocket open: ${urls.relay}`,
    };
  });

  const s = st.sock;
  if (!s) {
    skip('publish', 'Post a test note', 'Skipped because the connection failed.');
    skip('fetch', 'Read it back', 'Skipped because the connection failed.');
  } else {
    // 3. Publish a hidden test event (app-data kind, replaced on every run).
    const ev = sign({
      kind: 30078,
      created_at: opts.now(),
      tags: [
        ['d', 'beamhop-relay-test'],
        ['expiration', String(opts.now() + 600)],
      ],
      content: 'Beamhop relay self-test — safe to ignore.',
    });
    const pub = await step('publish', 'Post a test note', async () => {
      s.send(JSON.stringify(['EVENT', ev]));
      const ok = await waitFor(s, t, (m) => m[0] === 'OK' && m[1] === ev.id);
      if (!ok)
        return {
          status: 'fail',
          message: 'The relay did not confirm the test post in time.',
          technical: `no OK for ${ev.id} within ${t}ms`,
        };
      if (ok[2] === true) {
        st.published = ev;
        return {
          status: 'pass',
          message: 'A test post was accepted.',
          technical: `OK ${ev.id} (kind 30078)`,
        };
      }
      const reason = String(ok[3] ?? '');
      const prefix = reason.split(':')[0] ?? '';
      if (POLICY_PREFIXES.includes(prefix))
        return {
          status: 'warn',
          message:
            'Your relay is reachable, but your rules did not let a stranger post. That is expected for private or strict relays.',
          technical: `OK false: ${reason}`,
        };
      return {
        status: 'fail',
        message: 'The relay refused the test post.',
        technical: `OK false: ${reason}`,
      };
    });

    // 4. Fetch it back.
    if (st.published && pub.status === 'pass') {
      const id = st.published.id;
      await step('fetch', 'Read it back', async () => {
        s.send(JSON.stringify(['REQ', 'beamhop-test', { ids: [id] }]));
        let found = false;
        const end = await waitFor(s, t, (m) => {
          if (m[0] === 'EVENT' && m[1] === 'beamhop-test' && (m[2] as NostrEvent)?.id === id)
            found = true;
          return (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === 'beamhop-test';
        });
        s.send(JSON.stringify(['CLOSE', 'beamhop-test']));
        if (found)
          return {
            status: 'pass',
            message: 'The test post could be read back.',
            technical: `REQ ids=[${id}] → EVENT + EOSE`,
          };
        return {
          status: 'fail',
          message: 'The test post was accepted but could not be read back.',
          technical: end ? `got ${String(end[0])} without the event` : `no EOSE within ${t}ms`,
        };
      });
    } else {
      skip('fetch', 'Read it back', 'Skipped because nothing was posted.');
    }
  }

  // 5. Blossom upload + download.
  if (!urls.blossom || opts.skipUpload) {
    skip('upload', 'Upload a file', 'Media hosting is turned off.');
  } else {
    const body = new TextEncoder().encode(`beamhop relay self-test ${opts.nowMs()}`);
    const sha = await opts.sha256Hex(body);
    const blossomAuth = (verb: 'upload' | 'delete') =>
      `Nostr ${b64(
        JSON.stringify(
          sign({
            kind: 24242,
            created_at: opts.now(),
            tags: [
              ['t', verb],
              ['x', sha],
              ['expiration', String(opts.now() + 300)],
            ],
            content: `Beamhop self-test ${verb}`,
          }),
        ),
      )}`;
    const base = urls.blossom;
    const up = await step('upload', 'Upload a file', async () => {
      const res = await opts.dialer.fetch(
        new Request(`${base}/upload`, {
          method: 'PUT',
          headers: {
            authorization: blossomAuth('upload'),
            'content-type': 'text/plain',
            'x-sha-256': sha,
          },
          body,
        }),
      );
      if (res.ok)
        return {
          status: 'pass',
          message: 'A small test file was uploaded.',
          technical: `PUT ${base}/upload → ${res.status} (BUD-02, kind 24242 auth)`,
        };
      const reason = res.headers.get('x-reason') ?? '';
      if (res.status === 401 || res.status === 403)
        return {
          status: 'warn',
          message:
            'Media hosting is reachable, but your rules did not let a stranger upload. That is expected for private relays.',
          technical: `PUT /upload → ${res.status} ${reason}`,
        };
      return {
        status: 'fail',
        message: `Uploading failed (${res.status}).`,
        technical: `PUT /upload → ${res.status} ${reason}`,
      };
    });
    if (up.status === 'pass') {
      await step('download', 'Download it again', async () => {
        const res = await opts.dialer.fetch(new Request(`${base}/${sha}`));
        if (!res.ok)
          return {
            status: 'fail',
            message: 'The uploaded file could not be downloaded.',
            technical: `GET /${sha} → ${res.status}`,
          };
        const got = await opts.sha256Hex(new Uint8Array(await res.arrayBuffer()));
        return got === sha
          ? {
              status: 'pass',
              message: 'The file came back intact.',
              technical: `GET /${sha} → 200, hash matches`,
            }
          : {
              status: 'fail',
              message: 'The file came back changed. A proxy may be altering files.',
              technical: `sha256 mismatch: ${got}`,
            };
      });
    } else {
      skip('download', 'Download it again', 'Skipped because the upload did not happen.');
    }
    if (up.status === 'pass') {
      // Best effort: remove the test file.
      try {
        await opts.dialer.fetch(
          new Request(`${base}/${sha}`, {
            method: 'DELETE',
            headers: { authorization: blossomAuth('delete') },
          }),
        );
      } catch {}
    }
  }

  // 6. Clean up the test event (NIP-09) and close.
  const sock2 = st.sock;
  if (sock2 && st.published) {
    const ev = st.published;
    try {
      sock2.send(
        JSON.stringify([
          'EVENT',
          sign({
            kind: 5,
            created_at: opts.now(),
            tags: [
              ['e', ev.id],
              ['a', `30078:${ev.pubkey}:beamhop-relay-test`],
            ],
            content: 'self-test cleanup',
          }),
        ]),
      );
    } catch {}
  }
  sock2?.close();

  const failed = steps.filter((x) => x.status === 'fail');
  const warned = steps.filter((x) => x.status === 'warn');
  const ok = failed.length === 0;
  return {
    relayId: relay.id,
    ok,
    summary: !ok
      ? `${failed.length} of ${steps.filter((x) => x.status !== 'skip').length} checks failed: ${failed.map((f) => f.title.toLowerCase()).join(', ')}.`
      : warned.length
        ? 'Your relay is reachable from the internet. Some checks were limited by your own rules.'
        : 'Everything works from the outside: connect, post, read and upload.',
    urls,
    steps,
    at: opts.now(),
  };
}
