// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Typed fetch wrapper for the admin API. Fleet-ready paths
 * (`/api/v1/nodes/self/...` and `/api/v1/nodes/self/relays/:relay/...`),
 * bearer session tokens with proactive refresh, plain-language errors.
 */
import { type NostrSigner, nip98Header } from '../auth/nip98.ts';
import { readSse } from './sse.ts';
import type {
  ActivityItem,
  ApiErrorBody,
  ApiIssue,
  AttentionCard,
  AuthStatus,
  BulkResult,
  CatalogAction,
  CommitResult,
  ConfigProposal,
  DiffLine,
  Health,
  JsonSchema,
  LiveMessage,
  NodeConfig,
  NodeInfo,
  PrincipalInfo,
  RelayConfig,
  RevisionInfo,
  RunResult,
  SelfCheck,
  SessionResponse,
  SignInCodes,
  UiRoute,
} from './types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly technical?: string,
    readonly issues?: ApiIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static from(status: number, body: unknown): ApiError {
    const e = (body as { error?: ApiErrorBody } | null)?.error;
    if (e && typeof e.message === 'string')
      return new ApiError(status, e.code ?? 'error', e.message, e.technical, e.issues);
    return new ApiError(
      status,
      'http_error',
      'The server gave an unexpected answer',
      `HTTP ${status}`,
    );
  }
}

export interface StoredSession {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface TokenStore {
  get(): StoredSession | null;
  set(s: StoredSession | null): void;
}

/** Session token storage: sessionStorage (per tab, cleared when the tab closes). */
export function sessionTokenStore(key = 'beamhop.session'): TokenStore {
  let mem: StoredSession | null = null;
  const storage = (): Storage | null => {
    try {
      return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get() {
      if (mem) return mem;
      const raw = storage()?.getItem(key);
      if (!raw) return null;
      try {
        mem = JSON.parse(raw) as StoredSession;
      } catch {
        mem = null;
      }
      return mem;
    },
    set(s) {
      mem = s;
      if (s) storage()?.setItem(key, JSON.stringify(s));
      else storage()?.removeItem(key);
    },
  };
}

export type Scope = 'node' | 'relay' | 'root' | 'abs';

export interface RequestOptions {
  body?: unknown;
  scope?: Scope;
  relayId?: string | null;
  headers?: Record<string, string>;
  /** Send the session token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
  /** Return the raw Response instead of parsed JSON. */
  raw?: boolean;
}

export interface ClientOptions {
  /** Origin of the API (default: the page origin). */
  origin?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  tokens: TokenStore;
  /** Re-authenticate silently (e.g. sign a fresh NIP-98 event); true when a new session was stored. */
  refresh?: () => Promise<boolean>;
  /** Called when the session is gone and could not be refreshed. */
  onAuthLost?: () => void;
  /** Seconds before expiry at which a proactive refresh is attempted. */
  refreshLeewaySeconds?: number;
  now?: () => number;
}

export class ApiClient {
  node = 'self';
  relayId: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly opts: ClientOptions) {}

  get origin(): string {
    return this.opts.origin ?? (typeof location === 'undefined' ? '' : location.origin);
  }

  private nowSec(): number {
    return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
  }

  /** Absolute URL for an API path in a scope. */
  url(path: string, scope: Scope = 'node', relayId: string | null = this.relayId): string {
    if (scope === 'abs') return `${this.origin}${path}`;
    if (scope === 'root') return `${this.origin}/api/v1${path}`;
    const node = `${this.origin}/api/v1/nodes/${encodeURIComponent(this.node)}`;
    if (scope === 'relay') {
      if (!relayId) throw new ApiError(0, 'no_relay', 'Choose a relay first');
      return `${node}/relays/${encodeURIComponent(relayId)}${path}`;
    }
    return `${node}${path}`;
  }

  get session(): StoredSession | null {
    return this.opts.tokens.get();
  }

  setSession(s: StoredSession | null): void {
    this.opts.tokens.set(s);
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.opts.refresh) return false;
    this.refreshing ??= this.opts.refresh().finally(() => {
      this.refreshing = null;
    });
    try {
      return await this.refreshing;
    } catch {
      return false;
    }
  }

  async request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const auth = o.auth !== false;
    if (auth) {
      const s = this.opts.tokens.get();
      const leeway = this.opts.refreshLeewaySeconds ?? 120;
      if (s && s.expiresAt - leeway <= this.nowSec()) {
        const ok = await this.tryRefresh();
        if (!ok && s.expiresAt <= this.nowSec()) this.opts.tokens.set(null);
      }
    }
    const res = await this.send(method, path, o, auth);
    if (res.status === 401 && auth && this.opts.tokens.get()) {
      if (await this.tryRefresh()) {
        const again = await this.send(method, path, o, auth);
        return this.parse<T>(again, o);
      }
      this.opts.tokens.set(null);
      this.opts.onAuthLost?.();
    }
    return this.parse<T>(res, o);
  }

  private async send(
    method: string,
    path: string,
    o: RequestOptions,
    auth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...o.headers };
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
    }
    const s = auth ? this.opts.tokens.get() : null;
    if (s && !headers.authorization) headers.authorization = `Bearer ${s.token}`;
    const f = this.opts.fetch ?? fetch;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;
      if (o.signal) init.signal = o.signal;
      return await f(this.url(path, o.scope ?? 'node', o.relayId ?? this.relayId), init);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new ApiError(0, 'offline', 'Could not reach your server', String(err));
    }
  }

  private async parse<T>(res: Response, o: RequestOptions): Promise<T> {
    if (o.raw) {
      if (!res.ok) throw ApiError.from(res.status, await res.json().catch(() => null));
      return res as unknown as T;
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) throw ApiError.from(res.status, json);
    return json as T;
  }

  get<T>(path: string, o?: RequestOptions) {
    return this.request<T>('GET', path, o);
  }

  post<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>('POST', path, { ...o, body: body ?? {} });
  }

  // ───────── sign-in ─────────

  authStatus() {
    return this.get<AuthStatus>('/auth/status', { auth: false });
  }

  me() {
    return this.get<PrincipalInfo>('/auth/me');
  }

  /** NIP-98 sign-in with a NIP-07 / NIP-46 signer; optional codes (claim, invite, recovery). */
  async signInNostr(signer: NostrSigner, codes: SignInCodes = {}): Promise<SessionResponse> {
    const body = JSON.stringify(codes);
    const url = this.url('/auth/nostr', 'node');
    const header = await nip98Header(signer, url, 'POST', body === '{}' ? undefined : body);
    const res = await this.request<SessionResponse>('POST', '/auth/nostr', {
      body: body === '{}' ? '' : body,
      auth: false,
      headers: { authorization: header, 'x-nostr-signer': signer.via },
    });
    this.setSession({ token: res.token, expiresAt: res.expiresAt });
    return res;
  }

  async logout(): Promise<void> {
    try {
      await this.post('/auth/logout');
    } finally {
      this.setSession(null);
    }
  }

  recoveryStatus() {
    return this.get<{ remaining: number; owner: boolean }>('/auth/recovery-codes');
  }

  // ───────── actions ─────────

  async actions(): Promise<CatalogAction[]> {
    const r = await this.get<{ actions: CatalogAction[] }>('/actions');
    return r.actions;
  }

  private actionScope(scope: 'node' | 'relay'): Scope {
    return scope === 'relay' ? 'relay' : 'node';
  }

  preview(id: string, input: unknown, scope: 'node' | 'relay' = 'relay') {
    return this.post<{ action: string; diff: DiffLine[] }>(
      `/actions/${encodeURIComponent(id)}/preview`,
      { input },
      { scope: this.actionScope(scope) },
    );
  }

  run<O = unknown>(
    id: string,
    input: unknown,
    scope: 'node' | 'relay' = 'relay',
    reason?: string,
  ): Promise<RunResult<O>> {
    const body: { input: unknown; reason?: string } = { input };
    if (reason) body.reason = reason;
    return this.post<RunResult<O>>(`/actions/${encodeURIComponent(id)}`, body, {
      scope: this.actionScope(scope),
    });
  }

  bulk(id: string, inputs: unknown[], scope: 'node' | 'relay' = 'relay') {
    return this.post<BulkResult>(
      `/actions/${encodeURIComponent(id)}/bulk`,
      { inputs },
      { scope: this.actionScope(scope) },
    );
  }

  undo(token: string, scope: 'node' | 'relay' = 'node') {
    return this.post<{ ok: boolean; undone: string }>(
      `/undo/${encodeURIComponent(token)}`,
      {},
      { scope: this.actionScope(scope) },
    );
  }

  // ───────── home ─────────

  health(relay = false) {
    return this.get<Health>('/health', { scope: relay ? 'relay' : 'node' });
  }

  async cards(relay = false): Promise<AttentionCard[]> {
    return (
      await this.get<{ cards: AttentionCard[] }>('/cards', { scope: relay ? 'relay' : 'node' })
    ).cards;
  }

  async ui(): Promise<UiRoute[]> {
    return (await this.get<{ routes: UiRoute[] }>('/ui')).routes;
  }

  async nodes(): Promise<NodeInfo[]> {
    return (await this.get<{ nodes: NodeInfo[] }>('/nodes', { scope: 'root' })).nodes;
  }

  activity(opts: { limit?: number; cursor?: string; relay?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.cursor) q.set('cursor', opts.cursor);
    const qs = q.toString();
    return this.get<{ items: ActivityItem[]; cursor?: string }>(`/activity${qs ? `?${qs}` : ''}`, {
      scope: opts.relay ? 'relay' : 'node',
    });
  }

  async playbooks() {
    return (
      await this.get<{ playbooks: Array<{ id: string; title: string; steps: number }> }>(
        '/playbooks',
      )
    ).playbooks;
  }

  playbook(id: string) {
    return this.get<{
      id: string;
      title: string;
      steps: Array<{ title: string; body: string; actionId?: string; input?: unknown }>;
    }>(`/playbooks/${encodeURIComponent(id)}`);
  }

  /**
   * Company sign-in buttons (enterprise identity module). Absent unless enabled:
   * any non-200 answer means "no SSO" and nothing is shown.
   */
  async ssoProviders(): Promise<Array<{ id: string; label: string; startUrl: string }>> {
    try {
      const r = await this.get<{
        providers: Array<{ id: string; label: string; startUrl: string; audiences?: string[] }>;
      }>('/sso/providers', { scope: 'root', auth: false });
      return (r.providers ?? []).filter((p) => !p.audiences || p.audiences.includes('admin'));
    } catch {
      return [];
    }
  }

  /** Public runtime self-check (TLS / proxy headers). Not part of the admin API. */
  selfCheck() {
    return this.get<SelfCheck>('/.well-known/beamhop/self-check', { scope: 'abs', auth: false });
  }

  /** Public runtime liveness (`/healthz`): connections, uptime. */
  healthz() {
    return this.get<{ status: string; connections?: number; uptimeSeconds?: number; tls?: string }>(
      '/healthz',
      { scope: 'abs', auth: false },
    );
  }

  // ───────── settings ─────────

  config() {
    return this.get<{ revision: number; config: NodeConfig; knownGoodRevision: number | null }>(
      '/config',
    );
  }

  relayConfig() {
    return this.get<{ revision: number; relay: RelayConfig }>('/config', { scope: 'relay' });
  }

  configSchema(relay = false) {
    return this.get<JsonSchema>('/config/schema', { scope: relay ? 'relay' : 'node' });
  }

  propose(
    change: { merge?: unknown; patch?: unknown[]; summary?: string },
    relay = false,
  ): Promise<ConfigProposal> {
    return this.post<ConfigProposal>('/config/propose', change, {
      scope: relay ? 'relay' : 'node',
    });
  }

  commit(proposalId: string, relay = false): Promise<CommitResult> {
    return this.post<CommitResult>(
      '/config/commit',
      { proposalId },
      { scope: relay ? 'relay' : 'node' },
    );
  }

  revisions(opts: { limit?: number; cursor?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.cursor) q.set('cursor', opts.cursor);
    const qs = q.toString();
    return this.get<{ items: RevisionInfo[]; cursor?: string }>(
      `/config/revisions${qs ? `?${qs}` : ''}`,
    );
  }

  revisionDiff(rev: number) {
    return this.get<{ diff: DiffLine[] }>(`/config/revisions/${rev}/diff`);
  }

  restore(rev: number) {
    return this.post<CommitResult>(`/config/revisions/${rev}/restore`);
  }

  // ───────── live ─────────

  /**
   * Subscribe to the live channel. Reconnects with backoff until `signal` aborts.
   * Returns when aborted.
   */
  async live(
    onMessage: (m: LiveMessage) => void,
    opts: {
      events?: string[];
      relay?: boolean;
      signal: AbortSignal;
      onState?: (up: boolean) => void;
    },
  ): Promise<void> {
    let delay = 1000;
    while (!opts.signal.aborted) {
      try {
        const qs = opts.events?.length ? `?events=${opts.events.join(',')}` : '';
        const res = await this.request<Response>('GET', `/live${qs}`, {
          raw: true,
          signal: opts.signal,
          scope: opts.relay ? 'relay' : 'node',
          headers: { accept: 'text/event-stream' },
        });
        if (!res.body) throw new Error('no body');
        opts.onState?.(true);
        delay = 1000;
        await readSse(res.body, onMessage);
      } catch (err) {
        if (opts.signal.aborted) break;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          opts.onState?.(false);
          return;
        }
      }
      opts.onState?.(false);
      if (opts.signal.aborted) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
