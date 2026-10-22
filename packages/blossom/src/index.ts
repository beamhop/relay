import type { CoreDeps, CreateBlossom } from "@beamhop/sdk";
import { createRoutes } from "./routes";
import { buildService, type BlossomOptions, type BlossomServiceImpl } from "./service";

/** Like `createBlossom` but with extra options (custom driver, mirror fetch, disabling sharp). */
export function createBlossomService(deps: CoreDeps, options: BlossomOptions = {}): Promise<BlossomServiceImpl> {
  return buildService(deps, options, createRoutes);
}

export const createBlossom: CreateBlossom = (deps) => createBlossomService(deps);

export type { BlossomOptions, BlossomServiceImpl, BlobDescriptor } from "./service";
export * from "./driver";
export { createImageProcessor, loadSharp, type ImageProcessor } from "./image";
export { stripMetadata, stripJpegMetadata, stripPngMetadata, stripWebpMetadata, type StripResult } from "./exif";
export { parseAuthHeader, verifyAuthEvent, AuthError, type AuthVerb, type BlossomAuth } from "./auth";
export { extFromMime, isMimeAllowed } from "./mime";
export { migrations as blossomMigrations } from "./repo";
