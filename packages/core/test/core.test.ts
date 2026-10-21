// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeEvent, makeKey } from '@beamhop/testkit';
import { memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import {
  BEAMHOP_VERSION,
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
    expect(resolveRelay(cfg, new URL('https://relay.example.com/team'))?.id).toBe('team');
    // Segment boundary: `/team` must not capture `/teams` or `/teammates`.
    expect(resolveRelay(cfg, new URL('https://relay.example.com/teams'))?.id).toBe('main');
    expect(resolveRelay(cfg, new URL('https://relay.example.com/teammates/x'))?.id).toBe('main');
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

  test('moduleSchemas() exposes registered module config schemas', async () => {
    const schema = z.object({ size: z.number().default(3) }).prefault({});
    const k = await createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config: parseConfig({}),
      modules: [
        { id: 'with', configSchema: schema, register() {} },
        { id: 'without', register() {} },
      ],
    });
    const all = k.moduleSchemas?.() ?? {};
    expect(Object.keys(all)).toEqual(['with']);
    expect(all.with).toBe(schema);
    expect(k.moduleConfig<{ size: number }>('with')?.size).toBe(3);
  });
});

describe('version', () => {
  test('BEAMHOP_VERSION comes from the root package.json', async () => {
    const root = (await import('../../../package.json', { with: { type: 'json' } })).default as {
      version: string;
    };
    expect(root.version).toBe('0.1.0');
    expect(BEAMHOP_VERSION).toBe(root.version);
  });
});

describe('applyConfig module sections', () => {
  const schema = z.object({ a: z.number().default(1), list: z.array(z.string()).default([]) });
  const mod = (id: string, optional = false) => ({
    id,
    configSchema: schema,
    ...(optional ? { optional: true } : {}),
    register() {},
  });
  const base = () => parseConfig({ relays: [{ id: 'main', hosts: ['r.test'] }] });

  test('partial and missing sections are parsed with defaults; invalid ones keep the previous', async () => {
    const config = base();
    const k = await createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config,
      modules: [mod('m')],
    });
    expect(k.moduleConfig('m')).toEqual({ a: 1, list: [] });
    const seen: unknown[] = [];
    k.onConfigChange((next) => {
      seen.push(next.modules.m);
    });
    await k.applyConfig({ ...config, modules: { m: { a: 5 } } });
    expect(k.moduleConfig('m')).toEqual({ a: 5, list: [] });
    expect(seen.at(-1)).toEqual({ a: 5, list: [] });
    await k.applyConfig({ ...config, modules: {} });
    expect(k.moduleConfig('m')).toEqual({ a: 1, list: [] });
    await k.applyConfig({ ...config, modules: { m: { a: 7 } } });
    await k.applyConfig({ ...config, modules: { m: { a: 'nope' } } });
    expect(k.moduleConfig('m')).toEqual({ a: 7, list: [] });
  });

  test('a hot-enabled module whose section is removed is not given defaults', async () => {
    const config = base();
    const k = await createKernel({ runtime: 'test', ports: memoryPorts(), config, modules: [] });
    await k.applyConfig({ ...config, modules: { h: {} } });
    await k.enableModule?.(mod('h', true));
    await k.applyConfig({ ...config, modules: { h: { a: 2 } } });
    expect(k.moduleConfig('h')).toEqual({ a: 2, list: [] });
    await k.applyConfig({ ...config, modules: {} });
    expect(k.moduleConfig('h')).toBeUndefined();
  });
});
