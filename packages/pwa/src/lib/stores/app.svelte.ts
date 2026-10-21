// SPDX-License-Identifier: AGPL-3.0-or-later
/** App session state: who is signed in, which relay is selected, the action catalog. */
import { ApiClient, ApiError, sessionTokenStore } from '../api/client.ts';
import type {
  AuthStatus,
  CatalogAction,
  PrincipalInfo,
  RelaySummary,
  SessionResponse,
  UiRoute,
} from '../api/types.ts';
import type { NostrSigner } from '../auth/nip98.ts';
import {
  forgetBunker,
  hasExtension,
  nip07Signer,
  nip46Signer,
  storedBunker,
} from '../auth/signers.ts';

export type Phase = 'loading' | 'claim' | 'signin' | 'ready' | 'unreachable';

const RELAY_KEY = 'beamhop.relay';
const ONBOARDING_KEY = 'beamhop.onboarding';

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class AppState {
  readonly api: ApiClient;
  phase = $state<Phase>('loading');
  status = $state<AuthStatus | null>(null);
  me = $state<PrincipalInfo | null>(null);
  relays = $state<RelaySummary[]>([]);
  relayId = $state<string | null>(null);
  catalog = $state<CatalogAction[]>([]);
  uiRoutes = $state<UiRoute[]>([]);
  online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
  bootError = $state<ApiError | null>(null);
  /** Wizard in progress (persisted so a reload resumes it). */
  onboarding = $state<string | null>(null);
  /** Recovery codes shown once after claiming. */
  recoveryCodes = $state<string[] | null>(null);
  private signer: NostrSigner | null = null;

  constructor(api?: ApiClient) {
    this.api =
      api ??
      new ApiClient({
        tokens: sessionTokenStore(),
        refresh: () => this.silentRefresh(),
        onAuthLost: () => {
          this.me = null;
          this.phase = this.status?.claimed === false ? 'claim' : 'signin';
        },
      });
    try {
      this.onboarding = sessionStorage.getItem(ONBOARDING_KEY);
    } catch {
      this.onboarding = null;
    }
  }

  get relay(): RelaySummary | null {
    return this.relays.find((r) => r.id === this.relayId) ?? null;
  }

  /** Does the signed-in admin have `perm` (on the current relay when `relay` is true)? */
  can(perm: string, relay = true): boolean {
    const p = this.me?.permissions;
    if (!p) return false;
    const scope = relay && this.relayId ? (p[this.relayId] ?? []) : (p['*'] ?? []);
    return scope.includes(perm) || (p['*'] ?? []).includes(perm);
  }

  action(id: string): CatalogAction | undefined {
    return this.catalog.find((a) => a.id === id);
  }

  hasAction(id: string): boolean {
    return this.catalog.some((a) => a.id === id);
  }

  /**
   * Company SSO ends with a redirect to `/admin#sso_token=…&expires_at=…`:
   * store it as the session and clear the fragment (it never reaches a server).
   */
  takeSsoToken(): boolean {
    if (typeof location === 'undefined' || !location.hash.includes('sso_token=')) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get('sso_token');
    const expiresAt = Number(params.get('expires_at') ?? 0);
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!token) return false;
    this.api.setSession({ token, expiresAt: expiresAt || Math.floor(Date.now() / 1000) + 3600 });
    return true;
  }

  async boot(): Promise<void> {
    this.phase = 'loading';
    this.bootError = null;
    this.takeSsoToken();
    try {
      this.status = await this.api.authStatus();
    } catch (err) {
      this.bootError = err instanceof ApiError ? err : new ApiError(0, 'offline', String(err));
      this.phase = 'unreachable';
      return;
    }
    if (!this.status.claimed) {
      this.phase = 'claim';
      return;
    }
    if (!this.api.session) {
      // A bunker connection survives reloads in this tab: sign in again silently.
      if (!(await this.silentRefresh())) {
        this.phase = 'signin';
        return;
      }
    }
    await this.loadSession();
  }

  /** After a token is stored: load identity, relays, catalog, module routes. */
  async loadSession(): Promise<void> {
    try {
      this.me = await this.api.me();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.api.setSession(null);
        this.phase = 'signin';
        return;
      }
      throw err;
    }
    const [nodes, catalog, ui] = await Promise.all([
      this.api.nodes().catch(() => []),
      this.api.actions().catch(() => [] as CatalogAction[]),
      this.api.ui().catch(() => [] as UiRoute[]),
    ]);
    this.relays = nodes[0]?.relays ?? [];
    const saved = local()?.getItem(RELAY_KEY);
    const pick = this.relays.find((r) => r.id === saved) ?? this.relays[0];
    this.setRelay(pick?.id ?? null);
    this.catalog = catalog;
    this.uiRoutes = ui;
    this.phase = 'ready';
  }

  setRelay(id: string | null): void {
    this.relayId = id;
    this.api.relayId = id;
    if (id) local()?.setItem(RELAY_KEY, id);
  }

  async reloadRelays(): Promise<void> {
    const nodes = await this.api.nodes().catch(() => []);
    this.relays = nodes[0]?.relays ?? this.relays;
  }

  /** Sign in (or claim) with a Nostr signer; keeps the signer for silent refresh. */
  async signInWithNostr(
    kind: 'nip07' | 'nip46',
    opts: {
      bunker?: string;
      claimCode?: string;
      inviteCode?: string;
      recoveryCode?: string;
      onAuth?: (u: string) => void;
    } = {},
  ): Promise<SessionResponse> {
    const signer =
      kind === 'nip07'
        ? nip07Signer()
        : await nip46Signer(opts.bunker ?? '', opts.onAuth ? { onAuth: opts.onAuth } : {});
    const codes: Record<string, string> = {};
    if (opts.claimCode) codes.claimCode = opts.claimCode;
    if (opts.inviteCode) codes.inviteCode = opts.inviteCode;
    if (opts.recoveryCode) codes.recoveryCode = opts.recoveryCode;
    const res = await this.api.signInNostr(signer, codes);
    this.signer = signer;
    if (res.recoveryCodes) this.recoveryCodes = res.recoveryCodes;
    return res;
  }

  /**
   * Sign in (or claim) with a private key held in memory only. The NIP-98
   * login is signed here; the key itself never leaves this page.
   */
  async signInWithKey(
    sk: Uint8Array,
    opts: { claimCode?: string; inviteCode?: string; recoveryCode?: string } = {},
  ): Promise<SessionResponse> {
    const { localKeySigner } = await import('../auth/local-key.ts');
    const signer = await localKeySigner(sk);
    const codes: Record<string, string> = {};
    if (opts.claimCode) codes.claimCode = opts.claimCode;
    if (opts.inviteCode) codes.inviteCode = opts.inviteCode;
    if (opts.recoveryCode) codes.recoveryCode = opts.recoveryCode;
    try {
      const res = await this.api.signInNostr(signer, codes);
      await this.signer?.close?.();
      this.signer = signer;
      if (res.recoveryCodes) this.recoveryCodes = res.recoveryCodes;
      return res;
    } catch (err) {
      await signer.close?.();
      throw err;
    }
  }

  /** Re-fetch the action catalog and module screens (after a feature is turned on or off). */
  async refreshCatalog(): Promise<void> {
    const [catalog, ui] = await Promise.all([
      this.api.actions().catch(() => this.catalog),
      this.api.ui().catch(() => this.uiRoutes),
    ]);
    this.catalog = catalog;
    this.uiRoutes = ui;
  }

  /** Re-sign a NIP-98 login with the kept signer (bunker, or an extension that allows it). */
  async silentRefresh(): Promise<boolean> {
    try {
      let signer = this.signer;
      if (!signer) {
        const b = storedBunker();
        if (b) signer = await nip46Signer(b.uri, { reuse: b });
        else return false;
      }
      await this.api.signInNostr(signer);
      this.signer = signer;
      return true;
    } catch {
      return false;
    }
  }

  extensionAvailable(): boolean {
    return hasExtension();
  }

  setOnboarding(step: string | null): void {
    this.onboarding = step;
    try {
      if (step) sessionStorage.setItem(ONBOARDING_KEY, step);
      else sessionStorage.removeItem(ONBOARDING_KEY);
    } catch {
      // ignore
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      // the session may already be gone
    }
    await this.signer?.close?.();
    this.signer = null;
    forgetBunker();
    this.me = null;
    this.phase = 'signin';
  }
}

export const app = new AppState();
