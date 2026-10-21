// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MemoryBlobIndex,
  MemoryBlobStore,
  MemoryDocStore,
  MemoryEventStore,
  blobIndexContract,
  blobStoreContract,
  docStoreContract,
  eventStoreContract,
} from '../src/index.ts';

eventStoreContract('memory', async () => new MemoryEventStore());
blobStoreContract('memory', async () => new MemoryBlobStore());
blobIndexContract('memory', async () => new MemoryBlobIndex());
docStoreContract('memory', async () => new MemoryDocStore());
