// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BeamhopConfig, type Connection, defineModule, parseConfig } from '@beamhop/core';

export function tempDir(prefix = 'beamhop-rt-'): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
}

/** Local port binding may be denied (sandboxed CI); server tests skip then. */
export function canBind(): boolean {
  try {
    const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

export function testConfig(over: Record<string, unknown> = {}): BeamhopConfig {
  return parseConfig({
    node: { dataDir: tempDir(), listen: '127.0.0.1:0', tls: { mode: 'off' } },
    relays: [
      { id: 'alpha', hosts: ['alpha.test'] },
      { id: 'beta', hosts: ['beta.test'] },
      { id: 'team', hosts: ['alpha.test'], pathPrefix: '/team' },
    ],
    ...over,
  });
}

export interface StubState {
  opened: Connection[];
  messages: Array<{ conn: string; raw: string }>;
  closed: string[];
  stopped: number;
  claimed: boolean;
  lkg?: BeamhopConfig;
}

export function stubModule(state: StubState) {
  return defineModule({
    id: 'stub',
    register(k) {
      k.http.get('*', (c) => {
        const route = c.get('route');
        return c.json({ relayId: route?.relayId, publicUrl: route?.publicUrl, path: c.req.path });
      });
      k.ws = {
        onOpen(conn) {
          state.opened.push(conn);
          conn.state.set('stub', { n: 0 });
          conn.send(JSON.stringify(['HELLO', conn.relayId, conn.challenge]));
        },
        onMessage(conn, raw) {
          state.messages.push({ conn: conn.id, raw });
          const s = conn.state.get('stub') as { n: number };
          s.n++;
          if (raw === 'close') return conn.close(4000, 'bye');
          conn.send(JSON.stringify(['ECHO', raw, s.n, conn.ipHash, conn.bufferedAmount()]));
        },
        onClose(conn) {
          state.closed.push(conn.id);
        },
      };
      k.provide('admin.claim', {
        isClaimed: () => state.claimed,
        issueCode: async () => 'CLAIM-1234',
      });
      k.provide('admin.config', {
        lastKnownGood: async () => state.lkg ?? null,
      });
    },
    stop() {
      state.stopped++;
    },
  });
}

export function newState(): StubState {
  return { opened: [], messages: [], closed: [], stopped: 0, claimed: false };
}

export function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Open a WS and collect messages. */
export function openWs(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const messages: string[] = [];
  let closeCode: number | undefined;
  ws.onmessage = (e) => messages.push(String(e.data));
  ws.onclose = (e) => {
    closeCode = e.code;
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
  });
  return { ws, messages, opened, closeCode: () => closeCode };
}
