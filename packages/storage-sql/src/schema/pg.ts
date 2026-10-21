// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Postgres schema (separate from the SQLite one: jsonb, tsvector, bigint, "C" collation).
 * Source of truth for `drizzle-kit generate` (see drizzle.pg.config.ts).
 * Tag-extraction trigger lives in a custom migration.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  customType,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Text with bytewise ("C") collation: hex ids and doc keys sort like JS strings. */
const ctext = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const int8 = (name: string) => bigint(name, { mode: 'number' });

export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    relayId: text('relay_id').notNull(),
    id: ctext('id').notNull(),
    pubkey: text('pubkey').notNull(),
    createdAt: int8('created_at').notNull(),
    kind: int8('kind').notNull(),
    tags: jsonb('tags').notNull(),
    content: text('content').notNull(),
    sig: text('sig').notNull(),
    address: text('address'),
    expiresAt: int8('expires_at'),
    /** NIP-50 full-text search vector. */
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple', content)`),
  },
  (t) => [
    uniqueIndex('events_id_relay_uq').on(t.id, t.relayId),
    index('events_relay_created_idx').on(t.relayId, t.createdAt),
    index('events_relay_kind_created_idx').on(t.relayId, t.kind, t.createdAt),
    index('events_relay_pubkey_created_idx').on(t.relayId, t.pubkey, t.createdAt),
    index('events_relay_address_idx').on(t.relayId, t.address).where(sql`${t.address} IS NOT NULL`),
    index('events_expires_idx').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
    index('events_search_idx').using('gin', t.search),
  ],
);

export const tags = pgTable(
  'tags',
  {
    relayId: text('relay_id').notNull(),
    eventId: ctext('event_id').notNull(),
    name: text('name').notNull(),
    value: text('value').notNull(),
    createdAt: int8('created_at').notNull(),
  },
  (t) => [
    index('tags_lookup_idx').on(t.relayId, t.name, t.value, t.createdAt),
    index('tags_event_idx').on(t.eventId, t.relayId),
    foreignKey({
      name: 'tags_event_fk',
      columns: [t.eventId, t.relayId],
      foreignColumns: [events.id, events.relayId],
    }).onDelete('cascade'),
  ],
);

export const tombstones = pgTable(
  'tombstones',
  {
    relayId: text('relay_id').notNull(),
    type: text('type').notNull(),
    target: text('target').notNull(),
    pubkey: text('pubkey').notNull(),
    until: int8('until').notNull().default(0),
    createdAt: int8('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.relayId, t.type, t.target, t.pubkey] })],
);

export const blobOwners = pgTable(
  'blob_owners',
  {
    relayId: text('relay_id').notNull(),
    sha256: ctext('sha256').notNull(),
    pubkey: ctext('pubkey').notNull(),
    size: int8('size').notNull(),
    type: text('type').notNull(),
    uploadedAt: int8('uploaded_at').notNull(),
    expiresAt: int8('expires_at'),
  },
  (t) => [
    primaryKey({ columns: [t.relayId, t.sha256, t.pubkey] }),
    index('blob_owners_sha_idx').on(t.sha256),
    index('blob_owners_owner_idx').on(t.relayId, t.pubkey, t.uploadedAt),
    index('blob_owners_expires_idx').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
  ],
);

export const docs = pgTable(
  'docs',
  {
    collection: text('collection').notNull(),
    key: ctext('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: int8('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.key] })],
);

export const metrics = pgTable(
  'metrics',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    metric: text('metric').notNull(),
    labels: jsonb('labels').notNull(),
    t: int8('t').notNull(),
    v: doublePrecision('v').notNull(),
  },
  (t) => [
    index('metrics_metric_t_idx').on(t.metric, t.t),
    index('metrics_t_idx').on(t.t),
    index('metrics_labels_idx').using('gin', t.labels),
  ],
);
