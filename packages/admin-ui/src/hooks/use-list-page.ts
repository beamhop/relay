import * as React from "react";

/** Building blocks shared by the paged list pages (users, media, reports, events). */

type Page<T> = T[] | { items: T[]; total?: number };

/** The loaded pages of an infinite query as one list, plus the total the first page reports (if any). */
export function usePagedItems<T>(data: { pages: Page<T>[] } | undefined) {
  return React.useMemo(() => {
    const pages = data?.pages ?? [];
    const first = pages[0];
    return { items: pages.flatMap((p) => (Array.isArray(p) ? p : p.items)), total: first && !Array.isArray(first) ? first.total : undefined };
  }, [data]);
}

/**
 * Selected keys of a list. Keys whose item left the list (deleted, filtered out after an action) are dropped so counts
 * and bulk actions stay right, and the whole selection is cleared when `resetKey` changes (other filters): a bulk
 * action must never hit items that are no longer shown. `toggle`, `deselect` and `clear` are stable.
 */
export function useSelection<T>(items: T[], keyOf: (item: T) => string, resetKey: string) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const keyRef = React.useRef(keyOf);
  keyRef.current = keyOf;
  React.useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const keep = new Set(items.map(keyRef.current));
      const n = new Set([...s].filter((k) => keep.has(k)));
      return n.size === s.size ? s : n;
    });
  }, [items]);
  const lastReset = React.useRef(resetKey);
  React.useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    setSelected(new Set());
  }, [resetKey]);

  const toggle = React.useCallback(
    (key: string, on: boolean) =>
      setSelected((s) => {
        if (s.has(key) === on) return s;
        const n = new Set(s);
        if (on) n.add(key);
        else n.delete(key);
        return n;
      }),
    [],
  );
  const deselect = React.useCallback((keys: string[]) => setSelected((s) => new Set([...s].filter((k) => !keys.includes(k)))), []);
  const clear = React.useCallback(() => setSelected(new Set()), []);
  const setAll = (on: boolean) => setSelected(on ? new Set(items.map(keyOf)) : new Set());
  const allSelected = items.length > 0 && items.every((i) => selected.has(keyOf(i)));
  return { selected, toggle, deselect, clear, setAll, allSelected };
}

/**
 * A text field bound to a search param: the draft follows the param when it changes (back/forward, links) and is
 * committed `delay` ms after typing stops. Keep it in the component that renders the input, so typing doesn't
 * re-render the list.
 */
export function useDebouncedSearchParam(value: string | undefined, commit: (v: string | undefined) => void, delay = 300) {
  const [draft, setDraft] = React.useState(value ?? "");
  React.useEffect(() => setDraft(value ?? ""), [value]);
  const commitRef = React.useRef(commit);
  commitRef.current = commit;
  const valueRef = React.useRef(value);
  valueRef.current = value;
  React.useEffect(() => {
    const t = setTimeout(() => {
      if ((draft || undefined) !== valueRef.current) commitRef.current(draft || undefined);
    }, delay);
    return () => clearTimeout(t);
  }, [draft, delay]);
  return [draft, setDraft] as const;
}

/** A callback with a stable identity that always runs the latest `fn` (for props of memoised rows). */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = React.useRef(fn);
  React.useLayoutEffect(() => {
    ref.current = fn;
  });
  return React.useCallback((...args: A) => ref.current(...args), []);
}
