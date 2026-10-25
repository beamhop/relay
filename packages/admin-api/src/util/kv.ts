import type { Stores } from "@beamhop/sdk";

/**
 * Reads `namespace/key` from kv, creating it from `make()` if absent: insert-if-absent, then re-read, so instances
 * starting together on an empty kv all end up with the same value (whichever insert won). Throws if it can't be read back.
 */
export async function kvGetOrCreate<T>(stores: Pick<Stores, "db" | "kv">, namespace: string, key: string, make: () => T, nowSec: number, valid: (v: T | undefined) => v is T): Promise<T> {
  const existing = await stores.kv.get<T>(namespace, key);
  if (valid(existing)) return existing;
  try {
    await stores.db.run("INSERT INTO kv (namespace, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (namespace, key) DO NOTHING", [
      namespace,
      key,
      JSON.stringify(make()),
      nowSec,
    ]);
  } catch {
    await stores.kv.set(namespace, key, make()); // a kv store not backed by the SQL `kv` table
  }
  const stored = await stores.kv.get<T>(namespace, key);
  if (!valid(stored)) throw new Error(`${namespace}/${key} unavailable`);
  return stored;
}
