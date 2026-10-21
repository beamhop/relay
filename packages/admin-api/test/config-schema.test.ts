// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { NODE, RELAY, bootClaimed, call } from './helpers.ts';

function notes(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) for (const s of schema) notes(s, out);
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'x-technical' && typeof v === 'string') out.push(v);
      else notes(v, out);
    }
  }
  return out;
}

describe('config JSON Schema', () => {
  test('technical() notes are published as x-technical', async () => {
    const env = await bootClaimed();
    const node = await call(env.kernel, 'GET', `${NODE}/config/schema`, { token: env.ownerToken });
    expect(node.status).toBe(200);
    const all = notes(node.json);
    expect(all.some((n) => n.includes('NIP-13'))).toBe(true);
    expect(all.some((n) => n.startsWith('open: any pubkey'))).toBe(true);
    // Loaded modules' sections are described (with their notes) under modules.<id>.
    expect(node.json.properties.modules.properties['admin-api']).toBeDefined();
    expect(all.some((n) => n.includes('HS256 session signing key'))).toBe(true);

    const relay = await call(env.kernel, 'GET', `${RELAY()}/config/schema`, {
      token: env.ownerToken,
    });
    expect(relay.status).toBe(200);
    expect(notes(relay.json).some((n) => n.includes('BUD-02'))).toBe(true);
  });
});

describe('module config validation on propose', () => {
  test('changed modules.<id> sections are checked with the module schema', async () => {
    const env = await bootClaimed();
    const propose = (merge: unknown) =>
      call(env.kernel, 'POST', `${NODE}/config/propose`, {
        token: env.ownerToken,
        body: { merge },
      });
    const bad = await propose({ modules: { 'admin-api': { sessionTtlSeconds: 5 } } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('invalid_config');
    expect(bad.json.error.issues[0].path).toBe('modules.admin-api.sessionTtlSeconds');

    const good = await propose({ modules: { 'admin-api': { sessionTtlSeconds: 3600 } } });
    expect(good.status).toBe(200);
    expect(good.json.changed).toBe(true);

    // Sections of modules that are not loaded here stay opaque.
    const other = await propose({ modules: { 'not-loaded': { anything: [1, 2] } } });
    expect(other.status).toBe(200);
  });
});
