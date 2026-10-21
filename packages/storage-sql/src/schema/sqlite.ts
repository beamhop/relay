// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQLite schema shared by `bun:sqlite` and Cloudflare D1.
 *
 * Source of truth for `drizzle-kit generate` (see drizzle.sqlite.config.ts).
 * Triggers (tag extraction, FTS5 sync) live in a custom migration because
 * Drizzle cannot express them.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const events = sqliteTable(
  'events',
  {
    /** Rowid alias: compact secondary indexes and the FTS5 content_rowid. */
    seq: integer('seq').primaryKey(),
    relayId: text('relay_id').notNull(),
    id: text('id').notNull(),
    pubkey: text('pubkey').notNull(),
    createdAt: integer('created_at').notNull(),
    kind: integer('kind').notNull(),
    /** JSON array of tags, exactly as received. */
    tags: text('tags').notNull(),
    content: text('content').notNull(),
    sig: text('sig').notNull(),
    /** `kind:pubkey:d` for replaceable/addressable events, else NULL. */
    address: text('address'),
    /** NIP-40 expiration (unix seconds), else NULL. */
    expiresAt: integer('expires_at'),
  },
  (t) => [
    uniqueIndex('events_id_relay_uq').on(t.id, t.relayId),
    index('events_relay_created_idx').on(t.relayId, t.createdAt),
    index('events_relay_kind_created_idx').on(t.relayId, t.kind, t.createdAt),
    index('events_relay_pubkey_created_idx').on(t.relayId, t.pubkey, t.createdAt),
    index('events_relay_address_idx').on(t.relayId, t.address).where(sql`${t.address} IS NOT NULL`),
    index('events_expires_idx').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
  ],
);

/**
 * Single-letter tag index for `#x` filters. Maintained by triggers on `events`
 * (insert/delete), never written by application code. Physically WITHOUT ROWID
 * (see migrations/sqlite/0001_triggers_fts.sql).
 */
export const tags = sqliteTable(
  'tags',
  {
    relayId: text('relay_id').notNull(),
    eventId: text('event_id').notNull(),
    name: text('name').notNull(),
    value: text('value').notNull(),
    /** Denormalized for `since`/`until` pruning inside the tag index. */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // Covers `#x` lookups ordered by time. The custom migration rebuilds this
    // table WITHOUT ROWID so each tag is a single B-tree entry.
    primaryKey({
      name: 'tags_pk',
      columns: [t.relayId, t.name, t.value, t.createdAt, t.eventId],
    }),
  ],
);

/**
 * NIP-09 / NIP-62 tombstones.
 * - type 'e': target = event id, pubkey = deleter (must match author on re-publish)
 * - type 'a': target = address, until = deleted up to created_at
 * - type 'p': target = pubkey (vanish), until = vanished up to created_at
 */
export const tombstones = sqliteTable(
  'tombstones',
  {
    relayId: text('relay_id').notNull(),
    type: text('type').notNull(),
    target: text('target').notNull(),
    pubkey: text('pubkey').notNull(),
    until: integer('until').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.relayId, t.type, t.target, t.pubkey] })],
);

export const blobOwners = sqliteTable(
  'blob_owners',
  {
    relayId: text('relay_id').notNull(),
    sha256: text('sha256').notNull(),
    pubkey: text('pubkey').notNull(),
    size: integer('size').notNull(),
    type: text('type').notNull(),
    uploadedAt: integer('uploaded_at').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [
    primaryKey({ columns: [t.relayId, t.sha256, t.pubkey] }),
    index('blob_owners_sha_idx').on(t.sha256),
    index('blob_owners_owner_idx').on(t.relayId, t.pubkey, t.uploadedAt),
    index('blob_owners_expires_idx').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
  ],
);

export const docs = sqliteTable(
  'docs',
  {
    collection: text('collection').notNull(),
    key: text('key').notNull(),
    /** JSON text. */
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.key] })],
);

export const metrics = sqliteTable(
  'metrics',
  {
    seq: integer('seq').primaryKey(),
    metric: text('metric').notNull(),
    /** Canonical (key-sorted) JSON object. */
    labels: text('labels').notNull(),
    t: integer('t').notNull(),
    v: real('v').notNull(),
  },
  (t) => [index('metrics_metric_t_idx').on(t.metric, t.t), index('metrics_t_idx').on(t.t)],
);
