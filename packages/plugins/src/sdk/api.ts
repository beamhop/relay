// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Clock,
  type DocStore,
  type EventStore,
  type Logger,
  verifyEvent,
} from '@beamhop/core';
import type { PluginApi, PluginPermission } from './types.ts';

export class PluginPermissionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly permission: PluginPermission,
  ) {
    super(`Plugin ${pluginId} does not have the "${permission}" permission`);
    this.name = 'PluginPermissionError';
  }
}

export interface PluginApiDeps {
  id: string;
  permissions: readonly PluginPermission[];
  config: unknown;
  events: EventStore;
  docs: DocStore;
  clock: Clock;
  logger: Logger;
  fetch?: typeof fetch;
}

/** Permission-gated capabilities for an in-process plugin instance. */
export function createPluginApi(deps: PluginApiDeps): PluginApi<unknown> {
  const has = (p: PluginPermission) => deps.permissions.includes(p);
  const need = (p: PluginPermission) => {
    if (!has(p)) throw new PluginPermissionError(deps.id, p);
  };
  const collection = `plugin.${deps.id}`;
  const log = deps.logger.child({ plugin: deps.id });
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    id: deps.id,
    config: deps.config,
    permissions: deps.permissions,
    clock: { now: () => deps.clock.now(), nowMs: () => deps.clock.nowMs() },
    log: (level, msg, fields) => log.log(level, msg, fields),
    state: new Map(),
    events: {
      async query(relayId, filters, opts) {
        need('read-events');
        return deps.events.query(relayId, filters, {
          maxLimit: Math.min(opts?.maxLimit ?? 500, 5000),
        });
      },
      async count(relayId, filters) {
        need('read-events');
        return deps.events.count(relayId, filters);
      },
      async save(relayId, event) {
        need('write-events');
        if (!verifyEvent(event)) throw new Error('event signature is not valid');
        return (await deps.events.save(relayId, event)).status;
      },
    },
    docs: {
      async get(key) {
        need('docs');
        return deps.docs.get(collection, key);
      },
      async put(key, value) {
        need('docs');
        await deps.docs.put(collection, key, value);
      },
      async delete(key) {
        need('docs');
        return deps.docs.delete(collection, key);
      },
      async list(opts) {
        need('docs');
        return (await deps.docs.list(collection, { prefix: opts?.prefix, limit: opts?.limit }))
          .items as never;
      },
    },
    async fetch(input, init) {
      need('network');
      return doFetch(input as Request, init);
    },
  };
}
