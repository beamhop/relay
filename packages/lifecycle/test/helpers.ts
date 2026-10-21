// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type BeamhopModule,
  type BlobStore,
  type Kernel,
  type NostrEvent,
  type Principal,
  createKernel,
  finalizeEvent,
  parseConfig,
} from '@beamhop/core';
import { type SqlStores, createSqlStores } from '@beamhop/storage-sql';
import { MemoryBlobStore, type TestKey, memoryPorts } from '@beamhop/testkit';
import {
  type LifecycleOptions,
  type LifecycleService,
  createLifecycleModule,
} from '../src/index.ts';

export const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };
export const DAY = 86_400;

export interface SetupOptions {
  relays?: Array<Record<string, unknown>>;
  lifecycle?: Record<string, unknown>;
  backups?: Record<string, unknown>;
  /** Use real bun:sqlite stores in a temp dir. */
  sql?: boolean;
  options?: LifecycleOptions;
  modules?: BeamhopModule[];
  target?: BlobStore | null;
}

const cleanups: Array<() => Promise<void> | void> = [];

export async function cleanupAll() {
  for (const c of cleanups.splice(0)) await c();
}

export async function setup(o: SetupOptions = {}) {
  let stores: SqlStores | undefined;
  let dir: string | undefined;
  if (o.sql) {
    dir = mkdtempSync(join(tmpdir(), 'beamhop-lifecycle-'));
    stores = await createSqlStores({ driver: 'sqlite', path: join(dir, 'db', 'beamhop.sqlite') });
    await stores.migrate();
    const s = stores;
    const d = dir;
    cleanups.push(async () => {
      await s.close();
      rmSync(d, { recursive: true, force: true });
    });
  }
  const ports = memoryPorts(
    stores
      ? {
          events: stores.events,
          blobIndex: stores.blobIndex,
          docs: stores.docs,
          metrics: stores.metrics,
        }
      : {},
  );
  for (const s of [ports.events, ports.blobIndex, ports.docs, ports.metrics, ports.blobs])
    await s.init();
  const target = o.target === undefined ? new MemoryBlobStore() : o.target;
  const config = parseConfig({
    relays: o.relays ?? [{ id: 'main', hosts: ['relay.example.com'] }],
    backups: o.backups ?? {},
    modules: { lifecycle: o.lifecycle ?? {} },
  });
  const kernel: Kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [
      createLifecycleModule({
        ...(target ? { backupTarget: target } : {}),
        ...(stores ? { sql: { exec: stores.exec } } : {}),
        ...o.options,
      }),
      ...(o.modules ?? []),
    ],
  });
  const svc = kernel.use<LifecycleService>('lifecycle') as LifecycleService;

  const ctx = (relayId: string | null = 'main'): ActionContext => ({
    principal: OWNER,
    relayId,
    ports,
  });
  const act = async (id: string, input: unknown, relayId: string | null = 'main') => {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    const parsed = def.input.parse(input);
    const preview = def.preview ? await def.preview(parsed, ctx(relayId)) : [];
    const result = await def.run(parsed, ctx(relayId));
    return { preview, result };
  };
  const ev = (
    key: TestKey,
    partial: Partial<Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>> = {},
  ) =>
    finalizeEvent(
      {
        kind: partial.kind ?? 1,
        tags: partial.tags ?? [],
        content: partial.content ?? `hello ${Math.random()}`,
        created_at: partial.created_at ?? ports.clock.now(),
      },
      key.sk,
    );
  return { kernel, ports, svc, stores, target, act, ctx, ev, dir };
}
