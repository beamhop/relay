import * as React from "react";

/**
 * Runs one action at a time: calls made while the previous one is still running are dropped. A `disabled`
 * button (or fieldset) only takes effect after React re-renders, so a fast double click would otherwise send the
 * request twice.
 */
export function useInFlight() {
  const busy = React.useRef(false);
  return React.useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    try {
      return await fn();
    } finally {
      busy.current = false;
    }
  }, []);
}
