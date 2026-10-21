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

    const relay = await call(env.kernel, 'GET', `${RELAY()}/config/schema`, {
      token: env.ownerToken,
    });
    expect(relay.status).toBe(200);
    expect(notes(relay.json).some((n) => n.includes('BUD-02'))).toBe(true);
  });
});
