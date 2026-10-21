// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionContext,
  type BeamhopModule,
  type Kernel,
  type Principal,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { type AlertsModuleOptions, type AlertsRuntime, createAlertsModule } from '../src/index.ts';

export const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

export interface Call {
  url: string;
  init: RequestInit;
  json?: unknown;
}

export function recordingFetch(status = 200) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    let json: unknown;
    if (typeof init.body === 'string') {
      try {
        json = JSON.parse(init.body);
      } catch {
        json = undefined;
      }
    }
    calls.push({ url, init, json });
    return new Response('{}', { status });
  };
  return { calls, fetchFn };
}

export async function setup(
  opts: {
    alerts?: Record<string, unknown>;
    config?: Record<string, unknown>;
    modules?: BeamhopModule[];
    options?: AlertsModuleOptions;
    status?: number;
  } = {},
) {
  const ports = memoryPorts();
  // Align the fake clock to a Monday 10:00 UTC for predictable seasonality/digest tests.
  ports.clock.ms = Date.UTC(2026, 9, 19, 10, 0, 0);
  const { calls, fetchFn } = recordingFetch(opts.status);
  const config = parseConfig({
    relays: [{ id: 'main', hosts: ['relay.example.com'] }],
    modules: { alerts: opts.alerts ?? {} },
    ...opts.config,
  });
  const kernel: Kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [...(opts.modules ?? []), createAlertsModule({ fetch: fetchFn, ...opts.options })],
  });
  const rt = kernel.use<AlertsRuntime>('alerts') as AlertsRuntime;
  const ctx = (principal: Principal = OWNER, relayId: string | null = 'main'): ActionContext => ({
    principal,
    relayId,
    ports,
  });
  async function act(
    id: string,
    raw: unknown,
    principal: Principal = OWNER,
    relayId: string | null = 'main',
  ) {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    const input = def.input.parse(raw);
    const c = ctx(principal, relayId);
    const preview = def.preview ? await def.preview(input, c) : [];
    const result = await def.run(input, c);
    return {
      preview,
      result,
      undo: () => def.undo!(result.undo!.payload, c),
    };
  }
  /** Emit `n` rejections then advance one minute and evaluate. */
  async function minute(rejections: number, errors = 0) {
    for (let i = 0; i < rejections; i++)
      kernel.bus.emit('event.rejected', {
        relayId: 'main',
        eventId: `e${i}`,
        pubkey: 'p',
        kind: 1,
        reason: 'rate-limited: slow down',
      });
    for (let i = 0; i < errors; i++)
      kernel.bus.emit('error', { relayId: 'main', source: 'relay.store', message: 'x' });
    ports.clock.advance(60);
    return rt.evaluate();
  }
  return { ports, kernel, rt, calls, act, minute };
}

export function b64u(data: Uint8Array): string {
  let s = '';
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
