// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal structural types for the Cloudflare Workers APIs this runtime uses.
 *
 * We deliberately do not depend on `@cloudflare/workers-types` globals: the repo
 * typechecks with DOM + Bun types, and structural interfaces let every piece of
 * Durable Object / Connection logic be unit-tested under `bun test` with fakes.
 * Real CF objects satisfy these shapes.
 */

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface ScheduledControllerLike {
  /** Epoch ms of the scheduled time. */
  scheduledTime: number;
  cron: string;
}

// ───────────────────────────── Durable Objects ─────────────────────────────

export interface DurableObjectIdLike {
  toString(): string;
  readonly name?: string;
}

export interface DurableObjectStubLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** A WebSocket accepted via the Hibernation API (`state.acceptWebSocket`). */
export interface HibernatableWebSocket {
  send(message: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Max 2048 bytes once structured-cloned. Survives hibernation. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readonly readyState: number;
}

export interface DurableObjectStateLike {
  readonly id: DurableObjectIdLike;
  readonly storage: DurableObjectStorageLike;
  acceptWebSocket(ws: HibernatableWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableWebSocket[];
  getTags?(ws: HibernatableWebSocket): string[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil?(promise: Promise<unknown>): void;
}

// ───────────────────────────── D1 / R2 / Images ─────────────────────────────

/** D1 binding (opaque here; consumed by `@beamhop/storage-sql`). */
export interface D1DatabaseLike {
  prepare(query: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
}

/** R2 bucket binding (opaque here; consumed by `@beamhop/blobs`). */
export interface R2BucketLike {
  get(key: string, options?: unknown): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  head(key: string): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: unknown): Promise<unknown>;
}

export interface ImageTransformLike {
  width?: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
}

export interface ImageOutputOptionsLike {
  format: string;
  quality?: number;
}

export interface ImageTransformationResultLike {
  response(): Response;
  contentType(): string;
  image(): ReadableStream<Uint8Array>;
}

export interface ImageTransformerLike {
  transform(t: ImageTransformLike): ImageTransformerLike;
  output(o: ImageOutputOptionsLike): Promise<ImageTransformationResultLike>;
}

/** Cloudflare Images binding (`[images] binding = "IMAGES"`). */
export interface ImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): ImageTransformerLike;
}
