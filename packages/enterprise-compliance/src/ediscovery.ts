// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * eDiscovery export (§12.7): query events by users / groups / date range / kinds /
 * keywords and write a signed, verifiable archive to a blob store target:
 *
 *   events/<relay>.ndjson   one NIP-01 event per line (signatures intact)
 *   blobs.ndjson            blob manifest: sha256, size, type, owner, relay, present
 *   manifest.json           query, counts and sha256 + size of every file above
 *   signature.json          BIP-340 signature of sha256(manifest.json) by the node key
 *
 * Every file is content-addressed in the target store and pinned (never garbage
 * collected). Referenced blobs are pinned too. `verifyArchive` checks it all offline.
 */
import type { BlobStore, Filter, NostrEvent, RelayId } from '@beamhop/core';
import { verifyEvent } from '@beamhop/core';
import { COL } from './config.ts';
import type { LegalHolds } from './holds.ts';
import { identityOf } from './identity.ts';
import { nodeSigner, verifySignature } from './nodekey.ts';
import type { Rt } from './runtime.ts';
import { collect, fromUtf8, sha256, sha256Hex, toHex, utf8 } from './util.ts';

export const ARCHIVE_FORMAT = 'beamhop-ediscovery/1';

export interface ExportQuery {
  name?: string;
  relays?: string[];
  pubkeys?: string[];
  subjects?: Array<{ subject: string; idp?: string }>;
  groups?: string[];
  since?: number;
  until?: number;
  kinds?: number[];
  keywords?: string[];
  includeBlobs?: boolean;
}

export interface ArchiveFile {
  path: string;
  sha256: string;
  size: number;
  type: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  id: string;
  node: string;
  createdAt: number;
  createdBy: string;
  query: ExportQuery;
  counts: { events: number; archivedEvents: number; blobs: number; relays: number };
  truncated: boolean;
  signer: string;
  files: ArchiveFile[];
}

export interface ArchiveSignature {
  alg: 'bip340-schnorr-secp256k1';
  pubkey: string;
  manifestSha256: string;
  sig: string;
}

export interface ExportRecord {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  manifestSha256: string;
  signatureSha256: string;
  signer: string;
  files: ArchiveFile[];
  counts: ArchiveManifest['counts'];
  truncated: boolean;
}

function matchesKeywords(e: NostrEvent, kws: string[]): boolean {
  if (!kws.length) return true;
  const hay = `${e.content}\n${e.tags.map((t) => t.join(' ')).join('\n')}`.toLowerCase();
  return kws.some((k) => hay.includes(k.toLowerCase()));
}

function inRange(e: NostrEvent, q: ExportQuery): boolean {
  if (q.since !== undefined && e.created_at < q.since) return false;
  if (q.until !== undefined && e.created_at > q.until) return false;
  if (q.kinds?.length && !q.kinds.includes(e.kind)) return false;
  return true;
}

export class EDiscovery {
  constructor(
    private readonly rt: Rt,
    private readonly holds: LegalHolds,
    private readonly target: () => BlobStore = () => rt.ports.blobs,
  ) {}

  /** Pubkeys selected by the query, or null when the query is not limited to people. */
  async authors(q: ExportQuery): Promise<string[] | null> {
    const selected = new Set(q.pubkeys ?? []);
    const id = identityOf(this.rt.kernel);
    for (const s of q.subjects ?? []) {
      const pk = await id?.pubkeyOf?.(s.subject, s.idp);
      if (!pk) throw new Error(`No Nostr key is linked to ${s.subject}`);
      selected.add(pk);
    }
    if (q.groups?.length) {
      if (!id?.members)
        throw new Error('Exporting by group needs the company directory (enterprise identity)');
      for (const m of await id.members()) {
        if (m.groups.some((g) => q.groups!.includes(g))) selected.add(m.pubkey);
      }
    }
    const limited = !!(q.pubkeys?.length || q.subjects?.length || q.groups?.length);
    return limited ? [...selected] : null;
  }

  private async queryRelay(
    relayId: RelayId,
    q: ExportQuery,
    authors: string[] | null,
    budget: number,
  ): Promise<{ events: NostrEvent[]; truncated: boolean }> {
    const ev = this.rt.ports.events;
    const out = new Map<string, NostrEvent>();
    const chunks: Array<string[] | null> = [];
    if (authors)
      for (let i = 0; i < authors.length; i += 100) chunks.push(authors.slice(i, i + 100));
    else chunks.push(null);
    let truncated = false;
    for (const chunk of chunks) {
      if (chunk && chunk.length === 0) continue;
      let until = q.until;
      for (let page = 0; page < 100_000; page++) {
        const f: Filter = { limit: 500 };
        if (chunk) f.authors = chunk;
        if (q.kinds?.length) f.kinds = q.kinds;
        if (q.since !== undefined) f.since = q.since;
        if (until !== undefined) f.until = until;
        const res = await ev.query(relayId, [f], { maxLimit: 500 });
        for (const e of res) {
          if (matchesKeywords(e, q.keywords ?? [])) out.set(e.id, e);
          if (out.size >= budget) {
            truncated = true;
            break;
          }
        }
        if (truncated || res.length < 500) break;
        const oldest = res[res.length - 1]!.created_at;
        // Several events can share a second: step back one second and dedupe by id.
        until = oldest === until ? oldest - 1 : oldest;
        if (until < 0) break;
      }
      if (truncated) break;
    }
    return { events: [...out.values()].sort((a, b) => a.created_at - b.created_at), truncated };
  }

  private async put(path: string, data: Uint8Array, type: string): Promise<ArchiveFile> {
    const hash = await sha256Hex(data);
    await this.target().put({ sha256: hash, size: data.length, type }, data);
    await this.holds.pinBlob(hash, `ediscovery ${path}`);
    return { path, sha256: hash, size: data.length, type };
  }

  async export(q: ExportQuery, by: string): Promise<ExportRecord> {
    const cfg = this.rt.settings().ediscovery;
    const config = this.rt.kernel.config();
    const relays = q.relays?.length ? q.relays : config.relays.map((r) => r.id);
    const authors = await this.authors(q);
    const authorSet = authors ? new Set(authors) : null;
    const id = `exp_${this.rt.ports.crypto.randomHex(8)}`;
    const files: ArchiveFile[] = [];
    const blobLines: string[] = [];
    let total = 0;
    let archivedTotal = 0;
    let truncated = false;

    const archived = await this.holds.archived();
    for (const relayId of relays) {
      const { events, truncated: t } = await this.queryRelay(
        relayId,
        q,
        authors,
        Math.max(0, cfg.maxEvents - total),
      );
      truncated ||= t;
      const seen = new Set(events.map((e) => e.id));
      // Copies kept by the legal-hold archive (deleted from the live store).
      for (const a of archived) {
        if (a.relayId !== relayId || seen.has(a.event.id)) continue;
        if (authorSet && !authorSet.has(a.event.pubkey)) continue;
        if (!inRange(a.event, q) || !matchesKeywords(a.event, q.keywords ?? [])) continue;
        events.push(a.event);
        seen.add(a.event.id);
        archivedTotal++;
      }
      events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      total += events.length;
      const nd = events.map((e) => JSON.stringify(e)).join('\n');
      files.push(
        await this.put(
          `events/${relayId}.ndjson`,
          utf8(nd ? `${nd}\n` : ''),
          'application/x-ndjson',
        ),
      );

      if (q.includeBlobs ?? cfg.includeBlobs) {
        const owners = authors ?? null;
        const idx = this.rt.ports.blobIndex;
        const rows = [];
        if (owners) {
          for (const pk of owners) {
            const opts: { since?: number; until?: number; limit?: number } = { limit: 10_000 };
            if (q.since !== undefined) opts.since = q.since;
            if (q.until !== undefined) opts.until = q.until;
            rows.push(...(await idx.listByOwner(relayId, pk, opts)));
          }
        } else {
          let cursor: string | undefined;
          do {
            const page = await idx.list(relayId, { cursor, limit: 1000 });
            rows.push(
              ...page.items.filter(
                (o) =>
                  (q.since === undefined || o.uploadedAt >= q.since) &&
                  (q.until === undefined || o.uploadedAt <= q.until),
              ),
            );
            cursor = page.cursor;
          } while (cursor);
        }
        for (const o of rows) {
          const present = !!(await this.rt.ports.blobs.head(o.sha256));
          if (present) await this.holds.pinBlob(o.sha256, `ediscovery ${id}`);
          blobLines.push(
            JSON.stringify({
              relayId,
              sha256: o.sha256,
              size: o.size,
              type: o.type,
              owner: o.pubkey,
              uploadedAt: o.uploadedAt,
              present,
            }),
          );
        }
      }
    }
    files.push(
      await this.put(
        'blobs.ndjson',
        utf8(blobLines.length ? `${blobLines.join('\n')}\n` : ''),
        'application/x-ndjson',
      ),
    );

    const signer = await nodeSigner(this.rt.ports);
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      id,
      node: config.node.id,
      createdAt: this.rt.now(),
      createdBy: by,
      query: q,
      counts: {
        events: total,
        archivedEvents: archivedTotal,
        blobs: blobLines.length,
        relays: relays.length,
      },
      truncated,
      signer: signer.pubkey,
      files,
    };
    const manifestBytes = utf8(JSON.stringify(manifest, null, 2));
    const manifestHash = await sha256(manifestBytes);
    const signature: ArchiveSignature = {
      alg: 'bip340-schnorr-secp256k1',
      pubkey: signer.pubkey,
      manifestSha256: toHex(manifestHash),
      sig: await signer.sign(manifestHash),
    };
    const mf = await this.put('manifest.json', manifestBytes, 'application/json');
    const sf = await this.put(
      'signature.json',
      utf8(JSON.stringify(signature, null, 2)),
      'application/json',
    );
    const record: ExportRecord = {
      id,
      name: q.name ?? `Export ${new Date(manifest.createdAt * 1000).toISOString().slice(0, 10)}`,
      createdAt: manifest.createdAt,
      createdBy: by,
      manifestSha256: mf.sha256,
      signatureSha256: sf.sha256,
      signer: signer.pubkey,
      files: [...files, mf, sf],
      counts: manifest.counts,
      truncated,
    };
    await this.rt.ports.docs.put(COL.exports, id, record);
    this.rt.record({
      stream: 'compliance',
      type: 'ediscovery.exported',
      principalId: by,
      summary: `eDiscovery export “${record.name}” created (${total} posts)`,
      data: { exportId: id, manifestSha256: mf.sha256, counts: manifest.counts, query: q },
    });
    return record;
  }

  async get(id: string): Promise<ExportRecord | null> {
    return this.rt.ports.docs.get<ExportRecord>(COL.exports, id);
  }

  async list(): Promise<ExportRecord[]> {
    const page = await this.rt.ports.docs.list<ExportRecord>(COL.exports, { limit: 500 });
    return page.items.map((i) => i.value).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Read every file of an export back from the target store. */
  async files(id: string): Promise<Record<string, Uint8Array>> {
    const rec = await this.get(id);
    if (!rec) throw new Error('That export does not exist');
    const out: Record<string, Uint8Array> = {};
    for (const f of rec.files) {
      const b = await this.target().get(f.sha256);
      if (!b) throw new Error(`Archive file ${f.path} is missing from storage`);
      out[f.path] = await collect(b.body);
    }
    return out;
  }
}

export interface VerifyResult {
  ok: boolean;
  signer?: string;
  errors: string[];
  events: number;
}

/**
 * Verify an archive offline: signature over sha256(manifest.json), the sha256/size
 * of every listed file, NDJSON parse and (optionally) every Nostr event signature.
 */
export async function verifyArchive(
  files: Record<string, Uint8Array>,
  opts: { expectedSigner?: string; checkEventSignatures?: boolean } = {},
): Promise<VerifyResult> {
  const errors: string[] = [];
  const manifestBytes = files['manifest.json'];
  const sigBytes = files['signature.json'];
  if (!manifestBytes || !sigBytes)
    return { ok: false, errors: ['manifest.json or signature.json missing'], events: 0 };
  let manifest: ArchiveManifest;
  let sig: ArchiveSignature;
  try {
    manifest = JSON.parse(fromUtf8(manifestBytes)) as ArchiveManifest;
    sig = JSON.parse(fromUtf8(sigBytes)) as ArchiveSignature;
  } catch {
    return { ok: false, errors: ['manifest or signature is not valid JSON'], events: 0 };
  }
  const mh = await sha256(manifestBytes);
  if (toHex(mh) !== sig.manifestSha256) errors.push('manifest.json does not match its signature');
  if (!verifySignature(sig.sig, mh, sig.pubkey)) errors.push('signature is invalid');
  if (manifest.signer !== sig.pubkey) errors.push('manifest signer differs from signature key');
  if (opts.expectedSigner && sig.pubkey !== opts.expectedSigner)
    errors.push('archive was signed by an unexpected key');
  let events = 0;
  for (const f of manifest.files ?? []) {
    const data = files[f.path];
    if (!data) {
      errors.push(`${f.path} is missing`);
      continue;
    }
    if (data.length !== f.size) errors.push(`${f.path} has the wrong size`);
    if ((await sha256Hex(data)) !== f.sha256) errors.push(`${f.path} was modified`);
    if (f.path.startsWith('events/')) {
      for (const line of fromUtf8(data).split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as NostrEvent;
          events++;
          if (opts.checkEventSignatures && !verifyEvent(e))
            errors.push(`${f.path}: event ${e.id} has a bad signature`);
        } catch {
          errors.push(`${f.path}: a line is not valid JSON`);
        }
      }
    }
  }
  return { ok: errors.length === 0, signer: sig.pubkey, errors, events };
}
