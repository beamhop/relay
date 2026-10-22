import type { Migration } from "@beamhop/sdk";

// BIGINT / DOUBLE PRECISION are portable: sqlite maps them to INTEGER / REAL affinity,
// postgres needs them for unix seconds past 2038 and large byte counters.
export const migrations: Migration[] = [
  {
    id: "001_init",
    up: `
CREATE TABLE IF NOT EXISTS metrics_series (
  name TEXT NOT NULL,
  bucket BIGINT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (name, bucket)
);
CREATE INDEX IF NOT EXISTS metrics_series_bucket ON metrics_series (bucket);
CREATE TABLE IF NOT EXISTS metrics_kinds (
  bucket BIGINT NOT NULL,
  kind INTEGER NOT NULL,
  count BIGINT NOT NULL,
  PRIMARY KEY (bucket, kind)
);
CREATE TABLE IF NOT EXISTS metrics_pubkeys (
  bucket BIGINT NOT NULL,
  pubkey TEXT NOT NULL,
  events BIGINT NOT NULL,
  rejected BIGINT NOT NULL,
  PRIMARY KEY (bucket, pubkey)
);
CREATE TABLE IF NOT EXISTS metrics_rejections (
  bucket BIGINT NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  count BIGINT NOT NULL,
  PRIMARY KEY (bucket, code, reason)
);
CREATE TABLE IF NOT EXISTS metrics_geo (
  bucket BIGINT NOT NULL,
  country TEXT NOT NULL,
  country_name TEXT NOT NULL,
  city TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  connections BIGINT NOT NULL,
  events BIGINT NOT NULL,
  PRIMARY KEY (bucket, country, city)
);
`,
  },
];
