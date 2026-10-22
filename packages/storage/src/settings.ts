import type { DeepPartial, EventBus, Logger, RuntimeSettings, SettingsService, Stores } from "@beamhop/sdk";
import { RuntimeSettingsSchema } from "@beamhop/sdk";

export const SETTINGS_NAMESPACE = "settings";
export const SETTINGS_KEY = "runtime";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Deep merge: plain objects are merged recursively; arrays and scalars replace; `undefined` is ignored. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/**
 * Runtime settings backed by kv("settings","runtime"). Values are cached in memory; `update()`
 * validates with RuntimeSettingsSchema (throws ZodError on invalid input), persists, audits,
 * emits bus "settings.changed" and notifies onChange listeners. No-op updates are not persisted.
 */
export async function createSettingsService(stores: Stores, bus: EventBus, logger?: Logger): Promise<SettingsService> {
  const log = logger?.child("settings");
  const stored = await stores.kv.get<unknown>(SETTINGS_NAMESPACE, SETTINGS_KEY);
  let current: RuntimeSettings;
  const parsed = RuntimeSettingsSchema.safeParse(stored ?? {});
  if (parsed.success) current = parsed.data;
  else {
    log?.warn("stored runtime settings are invalid; falling back to defaults", { issues: parsed.error.issues.length });
    current = RuntimeSettingsSchema.parse({});
  }
  const listeners = new Set<(s: RuntimeSettings) => void>();
  let queue: Promise<unknown> = Promise.resolve();

  const apply = async (patch: DeepPartial<RuntimeSettings>, actor: string): Promise<RuntimeSettings> => {
    const next = RuntimeSettingsSchema.parse(deepMerge(current, patch));
    const changed = (Object.keys(next) as (keyof RuntimeSettings)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]),
    );
    if (!changed.length) return current;
    await stores.kv.set(SETTINGS_NAMESPACE, SETTINGS_KEY, next);
    current = next;
    await stores.audit.record({
      actor,
      action: "settings.update",
      target: null,
      details: { sections: changed, patch: patch as Record<string, unknown> },
      ip: null,
    });
    bus.emit("settings.changed", { settings: next, actor });
    for (const fn of listeners) {
      try {
        fn(next);
      } catch (err) {
        log?.error("settings listener failed", { err: String(err) });
      }
    }
    return next;
  };

  return {
    get: () => current,
    // serialized so concurrent patches merge on top of each other
    update(patch, actor) {
      const run = queue.then(() => apply(patch, actor));
      queue = run.catch(() => {});
      return run;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
