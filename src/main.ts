#!/usr/bin/env bun
import { loadConfig } from "./config";
import { ManagementState } from "./management";
import { createPluginManager, implementedNips } from "./plugins";
import { MemoryEventStore, SqliteEventStore } from "./storage";
import { startRelay } from "./server";

const config = await loadConfig();
const store = config.persistence ? new SqliteEventStore(config.persistence) : new MemoryEventStore();
const plugins = createPluginManager(config);
const management = new ManagementState();

const server = await startRelay({ config, store, plugins, management });

console.log(`beamhop-relay listening on ws://${config.host}:${server.port}/`);
console.log(`${config.persistence ? `sqlite persistence: ${config.persistence}` : "persistence: memory"}`);
if (config.admin.web) console.log(`admin panel: http://${config.host}:${server.port}/admin`);
console.log(`implemented plugins: ${implementedNips().length}, enabled: ${plugins.enabled.length}, disabled: ${plugins.disabled.size}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await store.close();
    server.stop(true);
    process.exit(0);
  });
}
