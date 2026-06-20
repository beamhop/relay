#!/usr/bin/env bun
import { loadConfig } from "./config";
import { ManagementState } from "./management";
import { createPluginManager, implementedNips } from "./plugins";
import { MemoryEventStore, SqliteEventStore, type EventStore } from "./storage";
import { startRelay } from "./server";
import type { PostgresConnectionConfig } from "./types";

const config = await loadConfig();
const store = await createStore();
const plugins = createPluginManager(config);
const management = new ManagementState();

const server = await startRelay({ config, store, plugins, management });

console.log(`beamhop-relay listening on ws://${config.host}:${server.port}/`);
console.log(`storage: ${storageDescription()}`);
if (config.admin.web) console.log(`admin panel: http://${config.host}:${server.port}/admin`);
console.log(`implemented plugins: ${implementedNips().length}, enabled: ${plugins.enabled.length}, disabled: ${plugins.disabled.size}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await store.close();
    server.stop(true);
    process.exit(0);
  });
}

async function createStore(): Promise<EventStore> {
  switch (config.storage.backend) {
    case "postgres": {
      // Keep the production-only Postgres backend off the standalone memory/sqlite paths (ADR-0001).
      const { PostgresEventStore } = await import("./storage/postgres");
      return new PostgresEventStore(postgresOptions(config.storage.postgres), config.storage.postgres?.schema);
    }
    case "sqlite":
      return new SqliteEventStore(config.storage.sqlitePath ?? "beamhop-relay.sqlite");
    default:
      return new MemoryEventStore();
  }
}

function postgresOptions(connection: PostgresConnectionConfig | undefined) {
  if (connection?.url) return connection.url;
  const options: Record<string, unknown> = {};
  if (connection?.host) options.host = connection.host;
  if (connection?.port) options.port = connection.port;
  if (connection?.database) options.database = connection.database;
  if (connection?.user) options.username = connection.user;
  if (connection?.password) options.password = connection.password;
  if (connection?.ssl !== undefined) options.ssl = connection.ssl;
  if (connection?.max !== undefined) options.max = connection.max;
  return options;
}

function storageDescription(): string {
  if (config.storage.backend === "sqlite") return `sqlite (${config.storage.sqlitePath})`;
  if (config.storage.backend === "postgres") {
    return `postgres (${config.storage.postgres?.url ? "url" : (config.storage.postgres?.host ?? "default host")})`;
  }
  return "memory";
}
