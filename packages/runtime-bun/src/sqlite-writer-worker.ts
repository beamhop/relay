// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQLite event writer thread (see sqlite-writer.ts). Owns a second connection to
 * the database file and runs every event-store write there. Each message is a
 * batch of operations; they are applied in order (saves of one batch share one
 * transaction through the store's group commit) and answered with one result each.
 */
import { createSqlStores } from '@beamhop/storage-sql';
import type { WriterReply, WriterRequest } from './sqlite-writer.ts';

interface WorkerScope {
  postMessage(m: WriterReply): void;
  onmessage: ((e: MessageEvent<WriterRequest>) => void) | null;
}
const scope = globalThis as unknown as WorkerScope;

type Stores = Awaited<ReturnType<typeof createSqlStores>>;
let stores: Promise<Stores> | null = null;
/** Messages are handled strictly in order. */
let chain: Promise<unknown> = Promise.resolve();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handle(m: WriterRequest): Promise<void> {
  if (m.type === 'open') {
    stores = createSqlStores({
      driver: 'sqlite',
      path: m.path,
      migrate: false,
      ...(m.pragmas ? { pragmas: m.pragmas } : {}),
    });
    try {
      await (await stores).events.init();
      scope.postMessage({ type: 'opened', seq: m.seq });
    } catch (err) {
      scope.postMessage({ type: 'opened', seq: m.seq, error: errorText(err) });
    }
    return;
  }
  if (!stores) {
    scope.postMessage({ type: 'done', seq: m.seq, results: [], error: 'writer not open' });
    return;
  }
  const s = await stores;
  if (m.type === 'close') {
    await s.close();
    scope.postMessage({ type: 'closed', seq: m.seq });
    return;
  }
  const ev = s.events;
  // Start every op before awaiting any: saves land in one group-commit transaction;
  // deletes commit queued saves first, so order is kept.
  const pending = m.ops.map((op) => {
    switch (op.op) {
      case 'save':
        return ev.save(op.relayId, op.event);
      case 'applyDeletion':
        return ev.applyDeletion(op.relayId, op.event);
      case 'vanish':
        return ev.vanish(op.relayId, op.pubkey, op.until);
      case 'deleteByIds':
        return ev.deleteByIds(op.relayId, op.ids, op.opts);
      case 'deleteMatching':
        return ev.deleteMatching(op.relayId, op.filter);
      case 'deleteExpired':
        return ev.deleteExpired(op.now);
    }
  });
  const settled = await Promise.allSettled(pending);
  scope.postMessage({
    type: 'done',
    seq: m.seq,
    results: settled.map((r) =>
      r.status === 'fulfilled' ? { ok: r.value } : { error: errorText(r.reason) },
    ),
  });
}

scope.onmessage = (e) => {
  const m = e.data;
  chain = chain.then(() => handle(m)).catch(() => {});
};
