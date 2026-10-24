import * as React from "react";
import { toast } from "sonner";
import type { LiveSnapshot, ReportView, StreamEvents } from "@beamhop/sdk/admin-contract";
import { API_BASE } from "./api";
import { queryClient } from "@/queries/client";
import { displayName } from "./nostr";

export type LiveEvent = StreamEvents["event"] & { receivedAt: number };
type Status = "idle" | "connecting" | "open" | "error";

const HISTORY = 180; // 6 min @ 2s

/** Single SSE connection to /admin/api/stream shared by the whole app. */
class LiveStore {
  snapshot: LiveSnapshot | null = null;
  history: LiveSnapshot[] = [];
  status: Status = "idle";
  private es: EventSource | null = null;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: LiveEvent) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private withEvents = false;
  onNavigate?: (url: string) => void;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    document.addEventListener("visibilitychange", this.onVisibility);
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.es?.close();
    this.es = null;
    this.setStatus("idle");
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.running && (!this.es || this.es.readyState === EventSource.CLOSED)) {
      this.retry = 0;
      this.connect();
    }
  };

  private setStatus(s: Status) {
    if (this.status !== s) {
      this.status = s;
      this.emit();
    }
  }

  /** subscribe to raw relay events (switches the stream to ?events=1 while ≥1 listener) */
  onEvent(fn: (e: LiveEvent) => void) {
    this.eventListeners.add(fn);
    this.updateEventMode();
    return () => {
      this.eventListeners.delete(fn);
      this.updateEventMode();
    };
  }
  private updateEventMode() {
    const want = this.eventListeners.size > 0;
    if (want !== this.withEvents) {
      this.withEvents = want;
      if (this.running) this.connect();
    }
  }

  private connect() {
    clearTimeout(this.timer);
    this.es?.close();
    this.setStatus("connecting");
    const es = new EventSource(`${API_BASE}/stream${this.withEvents ? "?events=1" : ""}`, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
    };
    es.onerror = () => {
      if (es !== this.es) return;
      if (es.readyState === EventSource.CLOSED) {
        this.setStatus("error");
        const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
        this.timer = setTimeout(() => this.running && this.connect(), delay);
      } else this.setStatus("connecting");
    };
    es.addEventListener("snapshot", (m) => {
      const s = parse<LiveSnapshot>(m);
      if (!s) return;
      this.snapshot = s;
      this.history = [...this.history.slice(-(HISTORY - 1)), s];
      queryClient.setQueryData(["snapshot"], s);
      this.emit();
    });
    es.addEventListener("event", (m) => {
      const e = parse<StreamEvents["event"]>(m);
      if (!e) return;
      const le = { ...e, receivedAt: Date.now() };
      this.eventListeners.forEach((fn) => fn(le));
    });
    es.addEventListener("alert", (m) => {
      const a = parse<StreamEvents["alert"]>(m);
      if (!a) return;
      const fn = a.level === "critical" ? toast.error : a.level === "warning" ? toast.warning : toast.info;
      fn(a.title, {
        description: a.message,
        duration: a.level === "critical" ? Infinity : 8000,
        action: a.url ? { label: "Open", onClick: () => this.openUrl(a.url!) } : undefined,
      });
    });
    es.addEventListener("report", (m) => {
      const r = parse<ReportView>(m);
      if (!r) return;
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      toast.warning(`New report: ${r.type}`, {
        description: `${displayName(r.reporter, r.reporterProfile)} reported ${displayName(r.targetPubkey, r.targetProfile)}`,
        action: { label: "Review", onClick: () => this.openUrl("/reports") },
      });
    });
  }

  private openUrl(url: string) {
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    else this.onNavigate?.(url.replace(/^\/admin/, ""));
  }
}

function parse<T>(m: Event): T | undefined {
  try {
    return JSON.parse((m as MessageEvent).data) as T;
  } catch {
    return undefined;
  }
}

export const live = new LiveStore();

export function useLiveSnapshot() {
  return React.useSyncExternalStore(live.subscribe, () => live.snapshot);
}
export function useLiveHistory() {
  return React.useSyncExternalStore(live.subscribe, () => live.history);
}
export function useLiveStatus() {
  return React.useSyncExternalStore(live.subscribe, () => live.status);
}
export function useLiveEvents(fn: (e: LiveEvent) => void, enabled = true) {
  const ref = React.useRef(fn);
  ref.current = fn;
  React.useEffect(() => {
    if (!enabled) return;
    return live.onEvent((e) => ref.current(e));
  }, [enabled]);
}
