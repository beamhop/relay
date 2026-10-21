// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * BlobStore adapters. Runtime-agnostic exports only; the Bun-only filesystem
 * adapter lives at `@beamhop/blobs/fs`.
 */
export { S3BlobStore, type S3BlobStoreOptions, type FetchLike } from './s3.ts';
export {
  R2BindingBlobStore,
  type R2BindingBlobStoreOptions,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
} from './r2.ts';
export { DEFAULT_TYPE, isSha256 } from './util.ts';
export {
  TieredBlobStore,
  tierInPlace,
  type Tier,
  type TieredBlobStoreOptions,
} from './tiered.ts';
export { createBlobStore, type BlobStoreFactoryOptions } from './factory.ts';
