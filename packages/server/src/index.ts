import { createBeamhop, type BeamhopOverrides } from "./app";
import type { BeamhopConfig } from "@beamhop/sdk";

export { createBeamhop, buildApp, fallthrough, isRelayUpgrade, isNip86, isWebSocketUpgrade, makeEnv } from "./app";
export type { Beamhop, BeamhopFactories, BeamhopOverrides, ServerEnv } from "./app";
export { loadConfig, envToConfig, toHexPubkey, toHexSecretKey, deepMerge } from "./config";
export type { LoadedConfig, LoadConfigOptions, ServerExtras } from "./config";
export { createPluginManager, PluginError } from "./plugins/manager";
export type { ServerPluginManager, PluginManagerDeps } from "./plugins/manager";
export { discoverPlugins } from "./plugins/discovery";
export { serve, startServer } from "./server";
export type { RunningServer, ServeOptions, StartedServer } from "./server";
export { createAssetSource, setEmbeddedUi } from "./static";
export { VERSION } from "./version";

/** Convenience: `createServer({ config, factories, ... })` → composed (not yet listening) beamhop instance. */
export function createServer(options: BeamhopOverrides & { config: BeamhopConfig }) {
  const { config, ...overrides } = options;
  return createBeamhop(config, overrides);
}
