import type { Filter, NostrEvent } from "@beamhop/sdk";
import type { Subscription } from "../protocol/connection";
import { matchFilter } from "../util/filter";

interface Entry {
  sub: Subscription;
  filter: Filter;
}

/**
 * Global fan-out index across all connections. Each filter is registered under its most selective
 * attribute (ids > authors > tag values > kinds); filters without any of these go to a broad list.
 * Candidate entries are then matched exactly with `matchFilter`.
 */
export class SubscriptionIndex {
  private index = new Map<string, Set<Entry>>();
  private broad = new Set<Entry>();
  private entries = new Map<Subscription, { entry: Entry; keys: string[] }[]>();

  get size() {
    return this.entries.size;
  }

  add(sub: Subscription): void {
    this.remove(sub);
    const regs: { entry: Entry; keys: string[] }[] = [];
    for (const filter of sub.filters) {
      const entry: Entry = { sub, filter };
      const keys = keysForFilter(filter);
      if (keys.length === 0) this.broad.add(entry);
      for (const k of keys) {
        let set = this.index.get(k);
        if (!set) this.index.set(k, (set = new Set()));
        set.add(entry);
      }
      regs.push({ entry, keys });
    }
    this.entries.set(sub, regs);
  }

  remove(sub: Subscription): void {
    const regs = this.entries.get(sub);
    if (!regs) return;
    for (const { entry, keys } of regs) {
      if (keys.length === 0) this.broad.delete(entry);
      for (const k of keys) {
        const set = this.index.get(k);
        if (!set) continue;
        set.delete(entry);
        if (set.size === 0) this.index.delete(k);
      }
    }
    this.entries.delete(sub);
  }

  /** All subscriptions with at least one filter matching the event. */
  match(event: NostrEvent): Set<Subscription> {
    const out = new Set<Subscription>();
    const check = (set: Set<Entry> | undefined) => {
      if (!set) return;
      for (const e of set) if (!out.has(e.sub) && matchFilter(e.filter, event)) out.add(e.sub);
    };
    check(this.index.get(`i:${event.id}`));
    check(this.index.get(`a:${event.pubkey}`));
    check(this.index.get(`k:${event.kind}`));
    for (const t of event.tags) {
      if (t[0].length === 1 && t[1] !== undefined) check(this.index.get(`t:${t[0]}:${t[1]}`));
    }
    check(this.broad);
    return out;
  }
}

function keysForFilter(f: Filter): string[] {
  if (f.ids) return f.ids.map((id) => `i:${id}`);
  if (f.authors) return f.authors.map((a) => `a:${a}`);
  let best: { name: string; values: string[] } | undefined;
  for (const key in f) {
    if (key[0] !== "#") continue;
    const values = f[key as `#${string}`];
    if (values && (!best || values.length < best.values.length)) best = { name: key.slice(1), values };
  }
  if (best) return best.values.map((v) => `t:${best!.name}:${v}`);
  if (f.kinds) return f.kinds.map((k) => `k:${k}`);
  return [];
}
