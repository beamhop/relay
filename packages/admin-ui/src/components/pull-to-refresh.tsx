import * as React from "react";
import { Loader2, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

const TRIGGER = 72;
const MAX = 120;

/** Pull-to-refresh for touch devices; window must be the scroll container. */
export function PullToRefresh({ onRefresh, children, className }: { onRefresh: () => Promise<unknown>; children: React.ReactNode; className?: string }) {
  const [pull, setPull] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const start = React.useRef<{ y: number; x: number } | null>(null);
  const pullRef = React.useRef(0);
  const cb = React.useRef(onRefresh);
  cb.current = onRefresh;

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia("(pointer: coarse)").matches) return;
    const onStart = (e: TouchEvent) => {
      if (window.scrollY > 0 || refreshing) return (start.current = null), undefined;
      start.current = { y: e.touches[0].clientY, x: e.touches[0].clientX };
    };
    const onMove = (e: TouchEvent) => {
      if (!start.current) return;
      const dy = e.touches[0].clientY - start.current.y;
      const dx = Math.abs(e.touches[0].clientX - start.current.x);
      if (dy <= 0 || dx > dy || window.scrollY > 0) {
        if (pullRef.current) set(0);
        return;
      }
      set(Math.min(MAX, dy * 0.5));
    };
    const onEnd = () => {
      if (!start.current) return;
      start.current = null;
      if (pullRef.current >= TRIGGER) {
        setRefreshing(true);
        set(TRIGGER * 0.75);
        Promise.resolve(cb.current()).finally(() => {
          setRefreshing(false);
          set(0);
        });
      } else set(0);
    };
    const set = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [refreshing]);

  const progress = Math.min(1, pull / TRIGGER);
  return (
    <div ref={ref} className={cn("relative", className)}>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
        style={{ transform: `translateY(${pull - 40}px)`, opacity: pull ? 1 : 0, transition: start.current ? "none" : "all 250ms ease" }}
      >
        <div className="flex size-9 items-center justify-center rounded-full border bg-background shadow-md">
          {refreshing ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <ArrowDown className="size-4 text-primary transition-transform" style={{ transform: `rotate(${progress >= 1 ? 180 : 0}deg)` }} />
          )}
        </div>
      </div>
      <div style={{ transform: pull ? `translateY(${pull}px)` : undefined, transition: start.current ? "none" : "transform 250ms ease" }}>{children}</div>
    </div>
  );
}
