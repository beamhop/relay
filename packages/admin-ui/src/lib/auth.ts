import type { ChallengeResponse, LoginResponse, NostrEvent } from "@beamhop/sdk/admin-contract";
import { api, API_BASE } from "./api";
import { queryClient } from "@/queries/client";

export interface EventSigner {
  signEvent(template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>;
}

declare global {
  interface Window {
    nostr?: EventSigner & { getPublicKey(): Promise<string> };
  }
}

/** NIP-98 login: GET /auth/challenge → sign kind 27235 → POST /auth/nostr */
export async function loginWithSigner(signer: EventSigner): Promise<LoginResponse> {
  const { challenge } = await api.get<ChallengeResponse>("/auth/challenge");
  const url = `${window.location.origin}${API_BASE}/auth/nostr`;
  const event = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["u", url], ["method", "POST"], ["challenge", challenge]],
    content: "",
  });
  const res = await api.post<LoginResponse>("/auth/nostr", { event });
  onLoggedIn(res);
  return res;
}

export async function loginWithExtension() {
  if (!window.nostr) throw new Error("No NIP-07 extension found (Alby, nos2x, Keys.band…)");
  return loginWithSigner(window.nostr);
}

const DEFAULT_CONNECT_RELAYS = ["wss://relay.nsec.app", "wss://relay.damus.io", "wss://nos.lol"];

/** NIP-46 via bunker:// URL or NIP-05 */
export async function loginWithBunker(input: string, onAuthUrl?: (url: string) => void) {
  const { BunkerSigner, parseBunkerInput } = await import("nostr-tools/nip46");
  const { generateSecretKey } = await import("nostr-tools/pure");
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error("Invalid bunker URL or NIP-05 address");
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, { onauth: (u) => (onAuthUrl ? onAuthUrl(u) : window.open(u, "_blank")) });
  try {
    await withTimeout(signer.connect(), 60_000, "Bunker did not respond");
    return await withTimeout(loginWithSigner(signer), 120_000, "Signing timed out");
  } finally {
    signer.close().catch(() => {});
  }
}

/** NIP-46 nostrconnect:// flow. Returns the URI to display and a promise resolving on login. */
export async function startNostrConnect(onAuthUrl?: (url: string) => void, relays = DEFAULT_CONNECT_RELAYS) {
  const { BunkerSigner, createNostrConnectURI } = await import("nostr-tools/nip46");
  const { generateSecretKey, getPublicKey } = await import("nostr-tools/pure");
  const sk = generateSecretKey();
  const secret = Math.random().toString(36).slice(2, 12);
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(sk),
    relays,
    secret,
    name: "beamhop admin",
    url: window.location.origin,
    perms: ["sign_event:27235"],
  });
  const abort = new AbortController();
  const done = (async () => {
    const signer = await BunkerSigner.fromURI(sk, uri, { onauth: (u) => (onAuthUrl ? onAuthUrl(u) : window.open(u, "_blank")) }, abort.signal);
    try {
      return await withTimeout(loginWithSigner(signer), 120_000, "Signing timed out");
    } finally {
      signer.close().catch(() => {});
    }
  })();
  return { uri, done, cancel: () => abort.abort() };
}

export async function loginWithPassword(login: string, password: string, totp?: string) {
  const res = await api.post<LoginResponse>("/auth/password", { login, password, totp: totp || undefined });
  onLoggedIn(res);
  return res;
}

export async function loginWithPasskey(login?: string) {
  const { startAuthentication } = await import("@simplewebauthn/browser");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const optionsJSON = await api.post<any>("/auth/passkey/login/options", login ? { login } : {});
  const response = await startAuthentication({ optionsJSON });
  const res = await api.post<LoginResponse>("/auth/passkey/login/verify", { response });
  onLoggedIn(res);
  return res;
}

export async function registerPasskey(name: string) {
  const { startRegistration } = await import("@simplewebauthn/browser");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const optionsJSON = await api.post<any>("/auth/passkey/register/options", {});
  const response = await startRegistration({ optionsJSON });
  await api.post("/auth/passkey/register/verify", { response, name });
  await queryClient.invalidateQueries({ queryKey: ["me"] });
}

export async function logout() {
  try {
    await api.post("/auth/logout");
  } finally {
    queryClient.clear();
  }
}

function onLoggedIn(res: LoginResponse) {
  if (res?.me) queryClient.setQueryData(["me"], res.me);
  else queryClient.invalidateQueries({ queryKey: ["me"] });
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}
