// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { memoryPorts } from '@beamhop/testkit';
import {
  PolicyPipeline,
  addressOf,
  createKernel,
  kindClass,
  matchFilter,
  parseClientMessage,
  parseConfig,
  reject,
  resolveRelay,
  validateEventShape,
  verifyEvent,
} from '../src/index.ts';

describe('event', () => {
  test('sign/verify roundtrip and tamper detection', () => {
    const e = makeEvent(makeKey(), { content: 'x' });
    expect(verifyEvent(e)).toBe(true);
    expect(verifyEvent({ ...e, content: 'y' })).toBe(false);
    expect(validateEventShape(e).ok).toBe(true);
    expect(validateEventShape({ ...e, kind: -1 }).ok).toBe(false);
  });
  test('kind classes and addresses', () => {
    expect(kindClass(0)).toBe('replaceable');
    expect(kindClass(10002)).toBe('replaceable');
    expect(kindClass(20001)).toBe('ephemeral');
    expect(kindClass(30023)).toBe('addressable');
    expect(kindClass(1)).toBe('regular');
    const k = makeKey();
    expect(addressOf(makeEvent(k, { kind: 30023, tags: [['d', 'a']] }))).toBe(`30023:${k.pk}:a`);
  });
});

describe('filter', () => {
  test('matches tags and ranges', () => {
    const e = makeEvent(makeKey(), { kind: 1, tags: [['p', 'abc']], created_at: 50 });
    expect(matchFilter({ kinds: [1], '#p': ['abc'] }, e)).toBe(true);
    expect(matchFilter({ '#p': ['zzz'] }, e)).toBe(false);
    expect(matchFilter({ since: 51 }, e)).toBe(false);
  });
});

describe('messages', () => {
  test('parse', () => {
    expect(parseClientMessage('["REQ","s",{}]').ok).toBe(true);
    expect(parseClientMessage('nope').ok).toBe(false);
    expect(parseClientMessage('["WAT"]').ok).toBe(false);
  });
});

describe('policy', () => {
  test('first non-accept wins by priority', async () => {
    const p = new PolicyPipeline();
    p.add({ id: 'b', priority: 200, onEvent: () => reject('blocked', 'b') });
    p.add({ id: 'a', priority: 100, onEvent: () => reject('rate-limited', 'a') });
    const d = await p.run('onEvent', [makeEvent(makeKey()), { relayId: 'r', now: 0 }]);
    expect(d).toMatchObject({ action: 'reject', by: 'a' });
  });
});

describe('config + routing + kernel', () => {
  test('defaults and virtual relay resolution', async () => {
    const cfg = parseConfig({
      relays: [
        { id: 'main', hosts: ['relay.example.com'] },
        { id: 'team', hosts: ['relay.example.com'], pathPrefix: '/team' },
      ],
    });
    expect(cfg.relays[0]?.goals.openness).toBe(70);
    expect(resolveRelay(cfg, new URL('https://relay.example.com/'))?.id).toBe('main');
    expect(resolveRelay(cfg, new URL('https://relay.example.com/team/x'))?.id).toBe('team');
    const order: string[] = [];
    const k = await createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config: cfg,
      modules: [
        { id: 'b', dependsOn: ['a'], register: () => void order.push('b') },
        { id: 'a', register: () => void order.push('a') },
      ],
    });
    expect(order).toEqual(['a', 'b']);
    expect(k.isEnabled('a')).toBe(true);
    expect(k.isEnabled('enterprise')).toBe(false);
  });
});
