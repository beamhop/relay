// SPDX-License-Identifier: AGPL-3.0-or-later
// Relay engine module: WebSocket protocol, subscriptions, NIP handlers
import { type Kernel, type RelayConfig, defineModule, resolveRelay } from '@beamhop/core';
import { RelayModuleConfigSchema } from './config.ts';
import { RELAY_MODULE_ID, RelayEngine } from './engine.ts';
import { NIP11_CORS_HEADERS, relayInfo } from './nip11.ts';
import { powHook } from './pow.ts';

export * from './config.ts';
export * from './engine.ts';
export * from './nip11.ts';
export * from './pow.ts';
export { SubscriptionIndex, matchLive, searchMatches } from './subindex.ts';
export type { IndexedSub } from './subindex.ts';
export { Negentropy, NegentropyStorageVector } from './vendor/negentropy.ts';

/** Service name under which the engine is exposed via `kernel.use()`. */
export const RELAY_ENGINE_SERVICE = 'relay.engine';
const EXPIRE_JOB = 'relay.expire';

const engines = new WeakMap<Kernel, RelayEngine>();

function rootPath(relay: RelayConfig): string {
  const p = relay.pathPrefix ?? '';
  return p === '' ? '/' : p;
}

function registerNip11(kernel: Kernel, engine: RelayEngine): void {
  const relayFor = (url: string, host: string | undefined, routeRelayId?: string) => {
    if (routeRelayId) return kernel.relay(routeRelayId);
    return resolveRelay(kernel.config(), new URL(url), host);
  };
  const isRoot = (relay: RelayConfig, path: string) => {
    const root = rootPath(relay);
    return path === root || path === `${root.replace(/\/$/, '')}/` || (root === '/' && path === '');
  };

  kernel.http.get('*', async (c, next) => {
    const accept = c.req.header('accept') ?? '';
    if (!accept.includes('application/nostr+json')) return next();
    const relay = relayFor(c.req.url, c.req.header('host'), c.get('route')?.relayId);
    if (!relay || !isRoot(relay, c.req.path)) return next();
    const doc = relayInfo(
      relay,
      kernel.limits(relay.id),
      kernel.ports.events.capabilities,
      engine.config(),
    );
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'Content-Type': 'application/nostr+json', ...NIP11_CORS_HEADERS },
    });
  });

  kernel.http.options('*', async (c, next) => {
    const relay = relayFor(c.req.url, c.req.header('host'), c.get('route')?.relayId);
    if (!relay || !isRoot(relay, c.req.path)) return next();
    return new Response(null, { status: 204, headers: NIP11_CORS_HEADERS });
  });
}

export const relayModule = defineModule({
  id: RELAY_MODULE_ID,
  configSchema: RelayModuleConfigSchema,
  register(kernel) {
    const engine = new RelayEngine(kernel);
    engines.set(kernel, engine);
    kernel.ws = engine;
    kernel.provide(RELAY_ENGINE_SERVICE, engine);
    kernel.policy.add(powHook(kernel));
    registerNip11(kernel, engine);
  },
  start(kernel) {
    const engine = engines.get(kernel);
    if (!engine) return;
    const { ports } = kernel;
    ports.scheduler.every(EXPIRE_JOB, engine.config().expireSweepSeconds, async () => {
      const n = await ports.events.deleteExpired(ports.clock.now());
      if (n > 0) ports.logger.log('info', 'expired events removed', { count: n });
    });
  },
  stop(kernel) {
    kernel.ports.scheduler.cancel(EXPIRE_JOB);
    engines.get(kernel)?.stop();
  },
});

export default relayModule;
