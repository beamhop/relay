// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How the CLI talks to a node: always through the admin API (so CLI, PWA
 * and API share one code path). Remote: HTTPS + API token. Local: the same
 * API served by an in-process kernel (`kernel.http.request`), no socket.
 */
import { type Kernel, dispatchHttp } from '@beamhop/core';
import { CliError } from './io.ts';

export interface ApiResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON from the API
  json: any;
  text: string;
  headers: Headers;
}

export interface AdminClient {
  readonly mode: 'remote' | 'local';
  /** Base URL (remote) or data dir (local), for messages. */
  readonly target: string;
  /** Absolute URL the server sees for `path` (NIP-98 `u` tag). */
  urlFor(path: string): string;
  /** `path` is below `/api/v1`, e.g. `/nodes/self/actions`. */
  request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<ApiResponse>;
  close(): Promise<void>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function toApiResponse(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

function jsonInit(method: string, body: unknown, headers: Record<string, string>): RequestInit {
  const h: Record<string, string> = { accept: 'application/json', ...headers };
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return init;
}

/** API root for a server URL: `https://relay.example.com` → `https://relay.example.com/api/v1`. */
export function apiRoot(url: string): string {
  const u = new URL(url.includes('://') ? url : `https://${url}`);
  const base = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${base.endsWith('/api/v1') ? base : `${base}/api/v1`}`;
}

/** Normalize what a user typed as a server address (used as credentials key). */
export function normalizeServerUrl(url: string): string {
  const u = new URL(url.includes('://') ? url : `https://${url}`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}`;
}

export function remoteClient(
  url: string,
  token: string | undefined,
  fetchFn: FetchLike = fetch,
): AdminClient {
  const root = apiRoot(url);
  return {
    mode: 'remote',
    target: normalizeServerUrl(url),
    urlFor: (path) => `${root}${path}`,
    async request(method, path, body, opts = {}) {
      const headers = { ...(opts.headers ?? {}) };
      if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
      let res: Response;
      try {
        res = await fetchFn(`${root}${path}`, jsonInit(method, body, headers));
      } catch (err) {
        throw new CliError(
          `Could not reach ${normalizeServerUrl(url)}. Is the server running and the address right?`,
          1,
          String(err),
        );
      }
      return toApiResponse(res);
    },
    async close() {},
  };
}

/** Client over an in-process kernel's HTTP app (local mode and tests). */
export function kernelClient(
  kernel: Pick<Kernel, 'http' | 'ports'>,
  auth: string | undefined,
  opts: { target?: string; onClose?: () => Promise<void> } = {},
): AdminClient {
  return {
    mode: 'local',
    target: opts.target ?? 'in-process',
    urlFor: (path) => `http://localhost/api/v1${path}`,
    async request(method, path, body, o = {}) {
      const headers = { ...(o.headers ?? {}) };
      if (auth && !headers.authorization) headers.authorization = auth;
      const req = new Request(`http://localhost/api/v1${path}`, jsonInit(method, body, headers));
      const res = await dispatchHttp(kernel, req, {
        relayId: '',
        publicUrl: 'http://localhost',
        ipHash: kernel.ports.crypto.hashIp('127.0.0.1'),
      });
      return toApiResponse(res);
    },
    close: opts.onClose ?? (async () => {}),
  };
}

/** Plain-language error from an API error body. */
export function apiError(res: ApiResponse, fallback = 'The server refused the request'): CliError {
  const e = res.json?.error as
    | { message?: string; technical?: string; issues?: Array<{ path: string; message: string }> }
    | undefined;
  let message = e?.message ?? `${fallback} (HTTP ${res.status})`;
  if (e?.issues?.length)
    message += `\n${e.issues.map((i) => `  - ${i.path || 'input'}: ${i.message}`).join('\n')}`;
  if (res.status === 401)
    message += '\nSign in first: `beamhop login <url>` (or pass --token / set BEAMHOP_TOKEN).';
  return new CliError(message, 1, e?.technical ?? `HTTP ${res.status}`);
}

export async function expectOk(res: Promise<ApiResponse> | ApiResponse): Promise<ApiResponse> {
  const r = await res;
  if (r.status < 200 || r.status >= 300) throw apiError(r);
  return r;
}

export const NODE = '/nodes/self';
export const relayPath = (relay: string) => `${NODE}/relays/${encodeURIComponent(relay)}`;
