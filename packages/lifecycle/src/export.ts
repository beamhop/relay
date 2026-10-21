// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Personal data export (portal "Download my data"): NDJSON stream of the
 * user's events followed by their blob manifest.
 *
 *   {"type":"export","format":"beamhop-user-export/1","relayId":…,"pubkey":…,"exportedAt":…}
 *   {"type":"event","event":{…}}            one per authored event, newest first
 *   {"type":"blob","sha256":…,"size":…,"mimeType":…,"uploadedAt":…,"expiresAt"?:…}
 *   {"type":"end","events":N,"blobs":M}
 */
import type { NostrEvent, Ports, RelayId } from '@beamhop/core';

export const USER_EXPORT_FORMAT = 'beamhop-user-export/1';

export interface ExportOptions {
  /** Events per query page. */
  pageSize?: number;
  /** Stop after this many events (the `end` line then has `truncated: true`). */
  maxEvents?: number;
}

type ExportPorts = Pick<Ports, 'events' | 'blobIndex' | 'clock'>;

async function* lines(
  ports: ExportPorts,
  relayId: RelayId,
  pubkey: string,
  opts: ExportOptions,
): AsyncGenerator<unknown> {
  const pageSize = opts.pageSize ?? 500;
  const max = opts.maxEvents ?? Number.POSITIVE_INFINITY;
  yield {
    type: 'export',
    format: USER_EXPORT_FORMAT,
    relayId,
    pubkey,
    exportedAt: ports.clock.now(),
  };
  const seen = new Set<string>();
  let until: number | undefined;
  let events = 0;
  let truncated = false;
  outer: for (;;) {
    const page: NostrEvent[] = await ports.events.query(relayId, [
      { authors: [pubkey], limit: pageSize, ...(until !== undefined ? { until } : {}) },
    ]);
    let fresh = 0;
    for (const event of page) {
      if (seen.has(event.id)) continue;
      if (events >= max) {
        truncated = true;
        break outer;
      }
      seen.add(event.id);
      fresh++;
      events++;
      yield { type: 'event', event };
    }
    if (page.length < pageSize) break;
    const minC = Math.min(...page.map((e) => e.created_at));
    // All-duplicate page: step past this second to make progress.
    until = fresh === 0 ? minC - 1 : minC;
  }
  let blobs = 0;
  let cursorUntil: number | undefined;
  for (;;) {
    const page = await ports.blobIndex.listByOwner(relayId, pubkey, {
      limit: 1000,
      ...(cursorUntil !== undefined ? { until: cursorUntil } : {}),
    });
    for (const o of page) {
      blobs++;
      yield {
        type: 'blob',
        sha256: o.sha256,
        size: o.size,
        mimeType: o.type,
        uploadedAt: o.uploadedAt,
        ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
      };
    }
    if (page.length < 1000) break;
    cursorUntil = Math.min(...page.map((o) => o.uploadedAt)) - 1;
  }
  yield { type: 'end', events, blobs, ...(truncated ? { truncated: true } : {}) };
}

/** NDJSON stream of everything `pubkey` stored on `relayId`. */
export function exportUserData(
  ports: ExportPorts,
  relayId: RelayId,
  pubkey: string,
  opts: ExportOptions = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = lines(ports, relayId, pubkey, opts);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next();
      if (next.done) controller.close();
      else controller.enqueue(enc.encode(`${JSON.stringify(next.value)}\n`));
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}
