import type { BeamhopConfig } from "@beamhop/sdk";
import { createFsDriver } from "./fs";
import { createS3Driver } from "./s3";
import type { BlobDriver } from "./types";

export * from "./types";
export { createFsDriver } from "./fs";
export { createS3Driver, type S3DriverConfig } from "./s3";

type BlossomConfig = BeamhopConfig["blossom"];

/** Creates the configured blob driver. Accepts either the full config or its `blossom` section. */
export function createBlobDriver(config: BeamhopConfig | BlossomConfig): BlobDriver {
  const cfg: BlossomConfig = "blossom" in config ? config.blossom : config;
  if (cfg.driver === "s3") {
    if (!cfg.s3) throw new Error("blossom.driver is 's3' but blossom.s3 is not configured");
    return createS3Driver(cfg.s3);
  }
  return createFsDriver(cfg.fsPath);
}
