// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BeamhopConfig, BlobStore, Logger } from '@beamhop/core';
import { S3BlobStore } from './s3.ts';

export type BlobStoreFactoryOptions = BeamhopConfig['blobStorage'] & {
  dataDir: string;
  logger?: Logger;
};

/**
 * Build a BlobStore from config. The fs adapter is imported lazily so Workers
 * bundles that only use S3/R2 never pull in `node:fs`.
 */
export async function createBlobStore(opts: BlobStoreFactoryOptions): Promise<BlobStore> {
  switch (opts.driver) {
    case 'fs': {
      // Variable specifier keeps Workers bundlers from pulling in `node:fs`.
      const fsModule = './fs.ts';
      const { FsBlobStore } = (await import(fsModule)) as typeof import('./fs.ts');
      return new FsBlobStore(opts.path ?? `${opts.dataDir.replace(/\/$/, '')}/blobs`);
    }
    case 's3':
    case 'r2':
    case 'gcs': {
      if (!opts.bucket || !opts.accessKeyId || !opts.secretAccessKey) {
        throw new Error(`blobStorage.${opts.driver} needs bucket, accessKeyId and secretAccessKey`);
      }
      const endpoint =
        opts.endpoint ??
        (opts.driver === 'gcs'
          ? 'https://storage.googleapis.com'
          : `https://s3.${opts.region ?? 'us-east-1'}.amazonaws.com`);
      return new S3BlobStore({
        endpoint,
        bucket: opts.bucket,
        region: opts.region ?? (opts.driver === 's3' ? 'us-east-1' : 'auto'),
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      });
    }
    default:
      throw new Error(`blob driver "${opts.driver}" is not built by createBlobStore`);
  }
}
