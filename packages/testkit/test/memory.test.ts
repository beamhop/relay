// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MemoryBlobIndex,
  MemoryBlobStore,
  MemoryDocStore,
  MemoryEventStore,
  MemoryTimeSeries,
  blobIndexContract,
  blobStoreContract,
  docStoreContract,
  eventStoreContract,
  timeSeriesContract,
} from '../src/index.ts';

eventStoreContract('memory', async () => new MemoryEventStore());
blobStoreContract('memory', async () => new MemoryBlobStore());
blobIndexContract('memory', async () => new MemoryBlobIndex());
docStoreContract('memory', async () => new MemoryDocStore());
timeSeriesContract('memory', async () => new MemoryTimeSeries());
