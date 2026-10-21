// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { parseConfig } from '@beamhop/core';
import { relayUrlMatches } from '../src/engine.ts';

describe('relayUrlMatches on catch-all relays', () => {
  const relay = parseConfig({ relays: [{ id: 'main', hosts: ['*'] }] }).relays[0]!;

  test('matches only the host the client connected to', () => {
    expect(relayUrlMatches(relay, 'wss://relay.example.com', 'relay.example.com')).toBe(true);
    expect(relayUrlMatches(relay, 'wss://other.example.org', 'relay.example.com')).toBe(false);
  });

  test('falls back to accepting when the runtime does not report a host', () => {
    expect(relayUrlMatches(relay, 'wss://anything.example', undefined)).toBe(true);
  });

  test('explicit hosts are unaffected by the connection host', () => {
    const named = parseConfig({ relays: [{ id: 'n', hosts: ['relay.example.com'] }] }).relays[0]!;
    expect(relayUrlMatches(named, 'wss://relay.example.com', 'x.example')).toBe(true);
    expect(relayUrlMatches(named, 'wss://evil.example', 'relay.example.com')).toBe(false);
  });
});
