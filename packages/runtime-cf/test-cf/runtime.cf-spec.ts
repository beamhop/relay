// SPDX-License-Identifier: AGPL-3.0-or-later
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
  });
}

describe('runtime-cf in workerd', () => {
  it('routes HTTP by host and 404s unknown hosts', async () => {
    const ok = await SELF.fetch('https://relay.test/hello');
    expect(await ok.text()).toBe('hello main');
    expect(await (await SELF.fetch('https://other.test/hello')).text()).toBe('hello other');
    const missing = await SELF.fetch('https://unknown.test/hello');
    expect(missing.status).toBe(404);
  });

  it('upgrades to a hibernatable RelayRoom socket and keeps state across messages', async () => {
    const res = await SELF.fetch('https://relay.test/', { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();
    let reply = nextMessage(ws);
    ws.send('AUTH pk1');
    expect(JSON.parse(await reply)).toEqual({ n: 1, raw: 'AUTH pk1', authed: [] });
    reply = nextMessage(ws);
    ws.send('ping');
    expect(JSON.parse(await reply)).toEqual({ n: 2, raw: 'ping', authed: ['pk1'] });
    ws.close();
  });
});
