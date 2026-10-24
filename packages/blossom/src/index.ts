import type { CoreDeps, CreateBlossom } from "@beamhop/sdk";
import { createRoutes } from "./routes";
import { buildService, type BlossomOptions, type BlossomServiceImpl } from "./service";

/** Like `createBlossom` but with extra options (custom driver, mirror fetch, disabling sharp). */
export function createBlossomService(deps: CoreDeps, options: BlossomOptions = {}): Promise<BlossomServiceImpl> {
  return buildService(deps, options, createRoutes);
}

/** Upload/mirror abuse limits from `config.blossom.limits` (unset fields keep the built-in defaults). */
export function optionsFromConfig(config: CoreDeps["config"]): BlossomOptions {
  const l = config.blossom.limits ?? {};
  const out: BlossomOptions = {};
  for (const k of [
    "uploadsPerMinutePerIp",
    "uploadsPerMinutePerPubkey",
    "maxConcurrentUploads",
    "maxQueuedUploads",
    "maxBufferedUploadBytes",
    "maxConcurrentUploadsPerIp",
    "uploadStallMs",
    "minUploadBytesPerSec",
    "mirrorPorts",
  ] as const) {
    if (l[k] !== undefined) (out as Record<string, unknown>)[k] = l[k];
  }
  // an empty allowlist would silently disable mirroring
  if (out.mirrorPorts && !out.mirrorPorts.length) throw new Error("blossom.limits.mirrorPorts must list at least one port");
  return out;
}

export const createBlossom: CreateBlossom = (deps) => createBlossomService(deps, optionsFromConfig(deps.config));

export type { BlossomOptions, BlossomServiceImpl, BlobDescriptor } from "./service";
export * from "./driver";
export { createImageProcessor, loadSharp, type ImageProcessor } from "./image";
export { stripMetadata, stripJpegMetadata, stripPngMetadata, stripWebpMetadata, type StripResult } from "./exif";
export { parseAuthHeader, verifyAuthEvent, AuthError, type AuthVerb, type BlossomAuth } from "./auth";
export { extFromMime, isMimeAllowed } from "./mime";
