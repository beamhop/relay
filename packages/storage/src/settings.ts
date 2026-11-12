import type { BusEvents, DeepPartial, EventBus, Logger, RuntimeSettings, SettingsService, Stores } from "@beamhop/sdk";
import { RuntimeSettingsSchema } from "@beamhop/sdk";
import { deepMerge, isPlainObject } from "@beamhop/sdk/util";

export const SETTINGS_NAMESPACE = "settings";
export const SETTINGS_KEY = "runtime";

type Alert = BusEvents["alert"];

/** Extra of the settings service: the alert about invalid stored settings, for re-emitting once listeners exist. */
export interface StartupAlerts {
  takeStartupAlert(): Alert | undefined;
}

export { deepMerge };

/**
 * Runtime settings backed by kv("settings","runtime"). Values are cached in memory; `update()`
 * validates with RuntimeSettingsSchema (throws ZodError on invalid input), persists, emits bus
 * "settings.changed", notifies onChange listeners, then audits (best effort: logged on failure).
 * No-op updates are not persisted.
 */
export async function createSettingsService(stores: Stores, bus: EventBus, logger?: Logger): Promise<SettingsService & StartupAlerts> {
  const log = logger?.child("settings");
  const stored = await stores.kv.get<unknown>(SETTINGS_NAMESPACE, SETTINGS_KEY);
  const { settings: current0, dropped } = salvageSettings(stored ?? {});
  let current: RuntimeSettings = current0;
  let startupAlert: Alert | undefined;
  if (dropped.length) {
    // invalid fields fall back to defaults, except access settings, which fail closed (see FAIL_CLOSED_ACCESS)
    log?.error("stored runtime settings had invalid fields", { fields: dropped });
    startupAlert = {
      level: "critical",
      title: "Invalid stored settings",
      message: `These runtime settings were invalid and were dropped (access settings were locked down instead): ${dropped.join(", ")}. Review them in the admin panel.`,
    };
    // the alert is emitted before most listeners exist (the server re-emits it once started, see
    // takeStartupAlert), so it is also kept in the audit log
    await stores.audit
      .record({ actor: "system", action: "settings.invalid", target: null, details: { dropped }, ip: null })
      .catch((err) => log?.warn("recording invalid settings failed", { err: String(err) }));
    bus.emit("alert", startupAlert);
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
    // persisted: everything that caches settings (word filters, limits, …) must follow now, whatever happens next
    current = next;
    notify(next, actor);
    // best effort: a failing audit write must not turn an applied change into an error
    await stores.audit
      .record({
        actor,
        action: "settings.update",
        target: null,
        details: { sections: changed, patch: patch as Record<string, unknown> },
        ip: null,
      })
      .catch((err) => log?.error("recording settings update failed", { err: String(err), sections: changed }));
    return next;
  };

  const notify = (next: RuntimeSettings, actor: string) => {
    bus.emit("settings.changed", { settings: next, actor });
    for (const fn of listeners) {
      try {
        fn(next);
      } catch (err) {
        log?.error("settings listener failed", { err: String(err) });
      }
    }
  };

  // after a database switch: the copy should hold the same settings, but the new database is authoritative now
  stores.dbSwitch?.onSwapped(async () => {
    const reloaded = await stores.kv.get<unknown>(SETTINGS_NAMESPACE, SETTINGS_KEY);
    const { settings: next, dropped } = salvageSettings(reloaded ?? {});
    if (dropped.length) log?.error("stored runtime settings had invalid fields after the database switch", { fields: dropped });
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    notify(next, "system");
  }, "settings.reload");

  return {
    takeStartupAlert() {
      const a = startupAlert;
      startupAlert = undefined;
      return a;
    },
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

/**
 * Access settings that fail validation are not reset to the (public) defaults: they fail closed, so a
 * corrupted or renamed field can't silently open a whitelist / auth-required relay.
 */
export const FAIL_CLOSED_ACCESS = { mode: "whitelist", authForRead: true, authForWrite: true, allowInboundToMembers: false } as const;

/**
 * Parses stored settings, dropping only the fields (or array elements) that fail validation, so one
 * bad or renamed field after an upgrade doesn't reset everything. Invalid `access.*` fields fail closed.
 */
export function salvageSettings(stored: unknown): { settings: RuntimeSettings; dropped: string[] } {
  // not an object at all (corrupted): nothing to salvage, and it must not come back as public defaults
  if (stored !== undefined && stored !== null && !isPlainObject(stored)) {
    return { settings: RuntimeSettingsSchema.parse({ access: FAIL_CLOSED_ACCESS }), dropped: ["(all)"] };
  }
  const candidate: Record<string, unknown> = isPlainObject(stored) ? structuredClone(stored) : {};
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const parsed = RuntimeSettingsSchema.safeParse(candidate);
    if (parsed.success) return { settings: parsed.data, dropped };
    let changed = false;
    const removals = new Map<unknown[], Set<number>>();
    for (const issue of parsed.error.issues) {
      const path = issue.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
      const hit = path[0] === "access" ? closeAccess(candidate, path) : markRemoval(candidate, path, removals);
      if (hit) {
        dropped.push(hit);
        changed = true;
      }
    }
    for (const [arr, idx] of removals) for (const i of [...idx].sort((a, b) => b - a)) arr.splice(i, 1);
    if (!changed) break;
  }
  dropped.push("(all)");
  return { settings: RuntimeSettingsSchema.parse({ access: FAIL_CLOSED_ACCESS }), dropped };
}

/**
 * Any invalid access field locks all of access down (FAIL_CLOSED_ACCESS as a whole): fixing only the bad
 * field could leave e.g. reads public on a relay that relied on an `auth-required` mode to gate them.
 * Other invalid access fields (not part of the fail-closed set) are removed.
 */
function closeAccess(root: Record<string, unknown>, path: (string | number)[]): string | null {
  const access = root.access;
  if (!isPlainObject(access) || path.length < 2) {
    root.access = { ...FAIL_CLOSED_ACCESS };
    return "access";
  }
  const key = String(path[1]);
  const wasClosed = Object.entries(FAIL_CLOSED_ACCESS).every(([k, v]) => access[k] === v);
  if (!wasClosed) Object.assign(access, FAIL_CLOSED_ACCESS);
  if (key in FAIL_CLOSED_ACCESS) return `access.${key}`; // its (invalid) value is now the locked-down one
  if (key in access) {
    delete access[key];
    return `access.${key}`;
  }
  return wasClosed ? null : "access";
}

/** Marks the array element (or deletes the deepest existing object key) along `path`. */
function markRemoval(root: unknown, path: (string | number)[], removals: Map<unknown[], Set<number>>): string | null {
  let node: unknown = root;
  let parent: Record<string, unknown> | null = null;
  let key: string | null = null;
  let depth = 0;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (Array.isArray(node)) {
      if (typeof seg !== "number" || seg < 0 || seg >= node.length) break;
      let set = removals.get(node);
      if (!set) removals.set(node, (set = new Set()));
      if (set.has(seg)) return null;
      set.add(seg);
      return path.slice(0, i + 1).join(".");
    }
    if (!isPlainObject(node) || !(String(seg) in node)) break;
    parent = node;
    key = String(seg);
    depth = i + 1;
    node = node[key];
  }
  if (!parent || key === null) return null;
  delete parent[key];
  return path.slice(0, depth).join(".");
}
