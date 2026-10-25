import type { ApiError } from "@beamhop/sdk/admin-contract";

/** "/admin/api" */
export const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "HttpError";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

function qs(q?: QueryParams): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
/** Called whenever an API call (other than /auth/*) answers 401. */
export function onUnauthorized(fn: UnauthorizedListener) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}
/** For requests made outside `rawRequest` (XHR uploads, plugin fetches) that got a 401. */
export function notifyUnauthorized() {
  unauthorizedListeners.forEach((fn) => fn());
}

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  /** raw body (string/Blob/FormData); sent as-is */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export const baseHeaders = { "X-Requested-With": "beamhop" } as const;

export async function rawRequest(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...baseHeaders, Accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${qs(opts.query)}`, { method, headers, body, credentials: "include", signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new HttpError(0, "Network error — is the relay reachable?");
  }
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.clone().json()) as ApiError;
      if (j?.error) msg = j.error;
      code = j?.code;
    } catch {
      /* not json */
    }
    if (res.status === 401 && !path.startsWith("/auth/")) notifyUnauthorized();
    throw new HttpError(res.status, msg, code);
  }
  return res;
}

async function request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
  const res = await rawRequest(method, path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  get: <T>(path: string, query?: QueryParams, signal?: AbortSignal) => request<T>("GET", path, { query, signal }),
  post: <T = unknown>(path: string, body?: unknown, query?: QueryParams) => request<T>("POST", path, { body: body ?? {}, query }),
  put: <T = unknown>(path: string, body?: unknown) => request<T>("PUT", path, { body: body ?? {} }),
  patch: <T = unknown>(path: string, body?: unknown) => request<T>("PATCH", path, { body: body ?? {} }),
  del: <T = unknown>(path: string, body?: unknown, query?: QueryParams) => request<T>("DELETE", path, { body, query }),
};

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const enc = encodeURIComponent;

/** Session-authenticated blob URL (works for pending/blocked blobs, unlike the public Blossom URL). */
export function mediaUrl(b: { sha256: string; hasThumbnail?: boolean }, thumbnail = false): string {
  return `${API_BASE}/media/${b.sha256}/raw${thumbnail && b.hasThumbnail ? "?thumb=1" : ""}`;
}
