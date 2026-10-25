import type { KvStore } from "@beamhop/sdk";

/**
 * Reads `namespace/key` from kv, creating it from `make()` if absent: insert-if-absent, then re-read, so instances
 * starting together on an empty kv all end up with the same value (whichever insert won). Throws if it can't be read back.
 */
export async function kvGetOrCreate<T>(kv: KvStore, namespace: string, key: string, make: () => T, valid: (v: T | undefined) => v is T): Promise<T> {
  const existing = await kv.get<T>(namespace, key);
  if (valid(existing)) return existing;
  await kv.setIfAbsent(namespace, key, make());
  const stored = await kv.get<T>(namespace, key);
  if (!valid(stored)) throw new Error(`${namespace}/${key} unavailable`);
  return stored;
}
