// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-kernel views of shared store instances.
 *
 * On Workers one isolate holds a single set of store adapters but several kernels (the
 * Worker kernel plus one per RelayRoom living in the isolate). Some modules wrap store
 * methods on the instance they are given (legal-hold guards, encryption at rest); on a
 * shared instance that would wrap it once per kernel (double encryption) and un-wrapping
 * one kernel would undo another's. Each kernel therefore gets its own thin delegating
 * object: patches land on the view, the adapter underneath stays untouched.
 */

/** Delegating object: every method of `base` (own and inherited) bound to `base`; other properties read through. */
export function storeView<T extends object>(base: T): T {
  const view: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let o: object | null = base; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor' || seen.has(key)) continue;
      seen.add(key);
      const desc = Object.getOwnPropertyDescriptor(o, key);
      if (desc && typeof desc.value === 'function') {
        view[key] = (desc.value as (...a: unknown[]) => unknown).bind(base);
      } else {
        Object.defineProperty(view, key, {
          get: () => (base as Record<string, unknown>)[key],
          // A write shadows the property on this view only.
          set: (v: unknown) => {
            Object.defineProperty(view, key, { value: v, writable: true, configurable: true });
          },
          enumerable: true,
          configurable: true,
        });
      }
    }
  }
  return view as T;
}
