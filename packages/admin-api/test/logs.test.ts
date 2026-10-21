// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { LogRedactor, LogRing, type StoredLog } from '../src/logs.ts';
import { NODE, bootClaimed, call } from './helpers.ts';

const rec = (i: number, o: Partial<StoredLog> = {}): StoredLog => ({
  at: 1000 + i,
  level: 'info',
  source: 'relay',
  message: `line ${i}`,
  fields: {},
  ...o,
});

describe('LogRing', () => {
  test('keeps the newest lines and counts dropped ones', () => {
    const ring = new LogRing(() => 3);
    for (let i = 0; i < 5; i++) ring.push(rec(i));
    expect(ring.query().map((r) => r.message)).toEqual(['line 4', 'line 3', 'line 2']);
    expect(ring.dropped).toBe(2);
  });

  test('capacity changes keep the newest lines', () => {
    let cap = 4;
    const ring = new LogRing(() => cap);
    for (let i = 0; i < 6; i++) ring.push(rec(i));
    cap = 2;
    ring.push(rec(6));
    expect(ring.query().map((r) => r.message)).toEqual(['line 6', 'line 5']);
    cap = 5;
    ring.push(rec(7));
    expect(ring.size).toBe(3);
    expect(ring.query()[0]?.message).toBe('line 7');
  });

  test('filters by level, source, text and time', () => {
    const ring = new LogRing(() => 100);
    ring.push(rec(1, { level: 'error', source: 'blossom', message: 'upload failed' }));
    ring.push(
      rec(2, { level: 'warn', source: 'relay', message: 'slow query', fields: { ms: 900 } }),
    );
    ring.push(rec(3, { level: 'debug', source: 'relay', message: 'tick' }));
    expect(ring.query({ level: ['error', 'warn'] })).toHaveLength(2);
    expect(ring.query({ source: 'bloss' })[0]?.message).toBe('upload failed');
    expect(ring.query({ text: '900' })[0]?.message).toBe('slow query');
    expect(ring.query({ since: 1002, until: 1002 })[0]?.message).toBe('slow query');
    expect(ring.query({ limit: 1 })).toHaveLength(1);
    expect(ring.sources()).toEqual(['blossom', 'relay']);
  });
});

describe('LogRedactor', () => {
  const r = new LogRedactor((ip) => `h(${ip})`);

  test('hashes raw IPs in fields and messages', () => {
    expect(r.text('connect from 203.0.113.9 ok')).toBe('connect from ip:h(203.0.113.9) ok');
    expect(r.text('peer 2001:db8::1 gone')).toBe('peer ip:h(2001:db8::1) gone');
    expect(r.text('at 12:30:45 done')).toBe('at 12:30:45 done');
    expect(r.fields({ ip: '198.51.100.7', nested: { remoteAddr: '::1' } })).toEqual({
      ip: 'ip:h(198.51.100.7)',
      nested: { remoteAddr: 'ip:h(::1)' },
    });
  });

  test('hides secrets and tokens', () => {
    const f = r.fields({
      apiKey: 'sk-123',
      token: 'abc',
      authorization: 'Bearer xyz',
      url: 'https://user:pass@example.com/x?token=abc&y=1',
      note: 'Bearer abc.def nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      count: 3,
      ok: true,
    });
    expect(f).toEqual({
      apiKey: '•••',
      token: '•••',
      authorization: '•••',
      url: 'https://•••@example.com/x?token=•••&y=1',
      note: 'Bearer ••• •••',
      count: 3,
      ok: true,
    });
  });
});

describe('logs.query', () => {
  test('returns kernel logger lines and bus errors, redacted', async () => {
    const env = await bootClaimed();
    env.kernel.ports.logger.child({ component: 'blossom' }).log('warn', 'upload from 203.0.113.9', {
      secret: 'hunter2',
    });
    env.kernel.bus.emit('error', { source: 'relay.store', message: 'disk full' });
    const res = await call(env.kernel, 'POST', `${NODE}/actions/logs.query`, {
      token: env.ownerToken,
      body: { input: { level: ['warn', 'error'] } },
    });
    expect(res.status).toBe(200);
    const out = res.json.output as {
      records: Array<{
        level: string;
        source: string;
        message: string;
        fields: Record<string, unknown>;
      }>;
      dropped: number;
    };
    expect(out.dropped).toBe(0);
    const warn = out.records.find((x) => x.source === 'blossom');
    expect(warn?.message).not.toContain('203.0.113.9');
    expect(warn?.message).toContain('ip:');
    expect(warn?.fields.secret).toBe('•••');
    expect(out.records.find((x) => x.source === 'relay.store')?.message).toBe('disk full');
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });
});
