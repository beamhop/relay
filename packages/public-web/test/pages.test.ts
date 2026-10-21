// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { BeamhopModule, Notification } from '@beamhop/core';
import type { PolicyService } from '@beamhop/policy';
import { makeKey } from '@beamhop/testkit';
import { type PublicWebService, npub } from '../src/index.ts';
import { HTML, admin, setup } from './helpers.ts';

const MAX_PAGE = 30 * 1024;

describe('content negotiation at /', () => {
  for (const publicFirst of [false, true]) {
    test(`NIP-11 still wins for application/nostr+json (publicFirst=${publicFirst})`, async () => {
      const h = await setup({ publicFirst });
      const res = await h.request('/', { headers: { accept: 'application/nostr+json' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/nostr+json');
      expect(((await res.json()) as { name: string }).name).toBe('Test Relay');

      const page = await h.html('/');
      expect(page.res.status).toBe(200);
      expect(page.res.headers.get('content-type')).toContain('text/html');
      expect(page.body).toContain('<!doctype html>');
      expect(page.body).toContain('Test Relay');
    });
  }

  test('root without text/html is left alone; websocket upgrades are not claimed', async () => {
    const h = await setup();
    expect((await h.request('/', { headers: { accept: '*/*' } })).status).toBe(404);
    const ws = await h.request('/', { headers: { ...HTML, upgrade: 'websocket' } });
    expect(ws.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});

describe('landing page', () => {
  test('renders connect info, QR, media URL, rules, branding and stays small', async () => {
    const owner = makeKey();
    const h = await setup({
      relay: {
        info: {
          name: 'Cozy Relay',
          description: 'A calm place',
          icon: 'https://cdn.test/icon.png',
          rules: 'Be kind.\nNo spam.',
          pubkey: owner.pk,
          contact: 'mailto:ops@relay.test',
        },
      },
      publicWeb: { branding: { main: { accent: '#ff8800', footer: 'Hosted with care' } } },
    });
    const { res, body } = await h.html('/');
    expect(body).toContain('Cozy Relay');
    expect(body).toContain('A calm place');
    expect(body).toContain('wss://relay.test');
    expect(body).toContain('<svg');
    expect(body).toContain('https://relay.test');
    expect(body).toContain('Be kind.');
    expect(body).toContain('--accent:#ff8800');
    expect(body).toContain('Hosted with care');
    expect(body).toContain(npub(owner.pk));
    expect(body).toContain('All systems normal');
    expect(body.length).toBeLessThan(MAX_PAGE);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /nonce-([0-9a-f]+)/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<script nonce="${nonce}"`);
  });

  test('allowlist shows the invite form; wot explains the web of trust', async () => {
    const a = await setup({ relay: { access: { mode: 'allowlist' } } });
    expect((await a.html('/')).body).toContain('name="invite"');
    const w = await setup({ relay: { access: { mode: 'wot', wot: { depth: 2 } } } });
    const wb = (await w.html('/')).body;
    expect(wb).toContain('web of trust');
    expect(wb).not.toContain('name="invite"');
  });

  test('npub encoding matches NIP-19 test vector', () => {
    expect(npub('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d')).toBe(
      'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
    );
  });
});

describe('private-only mode', () => {
  test('disabled surfaces answer 404, NIP-11 keeps working', async () => {
    const h = await setup({ relay: { public: { landing: false, portal: false, status: false } } });
    expect((await h.html('/')).res.status).toBe(404);
    expect((await h.html('/portal')).res.status).toBe(404);
    expect((await h.html('/status')).res.status).toBe(404);
    expect((await h.request('/status.json')).status).toBe(404);
    expect((await h.request('/portal/challenge', { method: 'POST' })).status).toBe(404);
    const nip11 = await h.request('/', { headers: { accept: 'application/nostr+json' } });
    expect(nip11.status).toBe(200);
  });

  test('a disabled status page hides the badge and nav link', async () => {
    const h = await setup({ relay: { public: { status: false } } });
    const { body } = await h.html('/');
    expect(body).not.toContain('id="status"');
    expect(body).not.toContain('href="/status"');
  });
});

describe('path-prefixed relays', () => {
  test('pages live under the prefix', async () => {
    const h = await setup({
      relays: [{ id: 'team', hosts: ['relay.test'], pathPrefix: '/team', info: { name: 'Team' } }],
    });
    const { res, body } = await h.html('/team/status');
    expect(res.status).toBe(200);
    expect(body).toContain('href="/team/portal"');
    expect((await h.html('/team')).body).toContain('wss://relay.test/team');
    expect((await h.html('/status')).res.status).toBe(404);
  });
});

describe('status page and incidents', () => {
  test('renders uptime bars and the in-memory uptime fallback', async () => {
    const h = await setup();
    const { res, body } = await h.html('/status');
    expect(res.status).toBe(200);
    expect(body).toContain('class="bars"');
    expect(body).toContain('No incidents right now.');
    expect(body.length).toBeLessThan(MAX_PAGE);
    const json = (await (await h.request('/status.json')).json()) as { level: string };
    expect(json.level).toBe('ok');
  });

  test('uses insights uptime when present', async () => {
    const insights: BeamhopModule = {
      id: 'fake-insights',
      register(k) {
        k.provide('insights', {
          async uptime(_relay: string, o: { from: number; to: number }) {
            return [{ day: o.from, ratio: 0.5 }];
          },
        });
      },
    };
    const h = await setup({ modules: [insights] });
    expect((await h.html('/status')).body).toContain('b-bad');
  });

  test('open, update, resolve and undo via actions', async () => {
    const h = await setup();
    const ctx = { principal: admin, relayId: 'main', ports: h.ports };
    const open = h.kernel.actions.get('status.open-incident')!;
    expect(open.permission).toBe('moderation.write');
    const preview = await open.preview!(
      open.input.parse({ title: 'Slow uploads', message: 'Looking into it', impact: 'major' }),
      ctx,
    );
    expect(preview[0]?.text).toContain('Slow uploads');
    const r = await open.run(
      open.input.parse({ title: 'Slow uploads', message: 'Looking into it', impact: 'major' }),
      ctx,
    );
    const id = (r.output as { id: string }).id;

    let page = (await h.html('/status')).body;
    expect(page).toContain('Slow uploads');
    expect(page).toContain('Partial outage');
    expect((await h.html('/')).body).toContain('Partial outage');

    const upd = h.kernel.actions.get('status.update-incident')!;
    const u = await upd.run(
      upd.input.parse({ id, message: 'Cause found: disk full', state: 'identified' }),
      ctx,
    );
    expect((await h.html('/status')).body).toContain('Cause found: disk full');
    await upd.undo!(u.undo!.payload, ctx);
    expect((await h.html('/status')).body).not.toContain('Cause found: disk full');

    const res = h.kernel.actions.get('status.resolve-incident')!;
    await res.run(res.input.parse({ id }), ctx);
    page = (await h.html('/status')).body;
    expect(page).toContain('No incidents right now.');
    expect(page).toContain('Recently resolved');
    expect(((await (await h.request('/status.json')).json()) as { level: string }).level).toBe(
      'ok',
    );

    const undoOpen = await open.run(open.input.parse({ title: 'Oops', message: 'typo' }), ctx);
    await open.undo!(undoOpen.undo!.payload, ctx);
    expect((await h.html('/status')).body).not.toContain('Oops');
  });

  test('critical alerts auto-open one incident (deduplicated)', async () => {
    let emit: ((n: Notification & { key?: string }) => void) | undefined;
    const alerts: BeamhopModule = {
      id: 'fake-alerts',
      register(k) {
        k.provide('alerts', {
          onAlert(fn: (n: Notification) => void) {
            emit = fn;
            return () => {
              emit = undefined;
            };
          },
        });
      },
    };
    const h = await setup({ modules: [alerts] });
    expect(emit).toBeDefined();
    emit?.({ severity: 'warning', title: 'Disk 80%', body: 'meh' });
    emit?.({ severity: 'critical', title: 'Relay down', body: 'No connections', key: 'down' });
    emit?.({ severity: 'critical', title: 'Relay down', body: 'Still down', key: 'down' });
    const svc = h.kernel.use<PublicWebService>('public-web')!;
    await Bun.sleep(5);
    const open = await svc.incidents.open('main');
    expect(open.length).toBe(1);
    expect(open[0]?.source).toBe('alert');
    expect((await h.html('/status')).body).toContain('Relay down');
  });
});
