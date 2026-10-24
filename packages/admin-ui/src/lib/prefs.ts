import * as React from "react";
import { useSystem } from "@/queries/auth";
import { originOf, type MediaPolicy } from "./media-policy";

/**
 * Per-browser boolean preferences (off unless the admin turns them on). localStorage can be missing or throw
 * (private mode, blocked storage): reads fall back to off, writes still apply for this page's lifetime.
 */
function boolPref(key: string) {
  const read = () => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  let value = read();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    get: () => value,
    set(on: boolean) {
      value = on;
      try {
        if (on) localStorage.setItem(key, "1");
        else localStorage.removeItem(key);
      } catch {
        /* storage unavailable: keep the in-memory value */
      }
      emit();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      // another tab changed it
      const onStorage = (e: StorageEvent) => {
        if (e.key !== key) return;
        value = read();
        emit();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(fn);
        window.removeEventListener("storage", onStorage);
      };
    },
  };
}

type BoolPref = ReturnType<typeof boolPref>;

/** "Load remote images and video": profile pictures, banners and note media from hosts other than this relay. */
export const remoteMediaPref = boolPref("beamhop:remote-media");
/** World map tiles from WORLD_MAP_TILE_HOST (a third party). */
export const worldMapPref = boolPref("beamhop:world-map-tiles");
export const WORLD_MAP_TILE_HOST = "demotiles.maplibre.org";

export function useBoolPref(p: BoolPref): [boolean, (on: boolean) => void] {
  const v = React.useSyncExternalStore(p.subscribe, p.get, p.get);
  return [v, p.set];
}

/** Media policy for this browser: this relay's origins (panel origin + publicUrl) always load, others need the opt-in. */
export function useMediaPolicy(): MediaPolicy {
  const [allowRemote] = useBoolPref(remoteMediaPref);
  const { data: sys } = useSystem();
  const publicOrigin = originOf(sys?.publicUrl);
  return React.useMemo(
    () => ({ allowRemote, trustedOrigins: [globalThis.location?.origin, publicOrigin].filter((o): o is string => !!o) }),
    [allowRemote, publicOrigin],
  );
}
