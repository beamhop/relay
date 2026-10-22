import type { Logger } from "@beamhop/sdk";
import { ConfigSchema } from "@beamhop/sdk";
import { createStores, type CreateStoresOptions, type StorageStores } from "./stores";

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};

/** Fresh in-memory SQLite stores for tests. Call `stores.flush()` to persist buffered user touches. */
export function createTestStores(opts: Omit<CreateStoresOptions, "db"> & { logger?: Logger } = {}): Promise<StorageStores> {
  const config = ConfigSchema.parse({ database: { driver: "sqlite", sqlitePath: ":memory:" } });
  return createStores(config, opts.logger ?? silentLogger, opts);
}
