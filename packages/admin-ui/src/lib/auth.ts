import type { ChallengeResponse, LoginResponse, NostrEvent } from "@beamhop/sdk/admin-contract";
import { api } from "./api";
import { queryClient } from "@/queries/client";
import { resetPluginUis } from "@/plugins/loader";

export interface EventSigner {
  signEvent(template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>;
}

declare global {
  interface Window {
    nostr?: EventSigner & { getPublicKey(): Promise<string> };
  }
}

/** NIP-98 login: GET /auth/challenge → sign kind 27235 → POST /auth/nostr */
async function loginWithSigner(signer: EventSigner): Promise<LoginResponse> {
  // the server names the exact URL to sign (its publicUrl), so logging in via a LAN IP / localhost works too
  const { challenge, url } = await api.get<ChallengeResponse>("/auth/challenge");
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

/** Local signing with an nsec / hex secret key. The key stays in memory for this call only — never stored or sent. */
export async function loginWithPrivateKey(input: string) {
  const { nip19 } = await import("nostr-tools");
  const { finalizeEvent } = await import("nostr-tools/pure");
  const s = input.trim().replace(/^nostr:/, "");
  let sk: Uint8Array;
  if (/^[0-9a-f]{64}$/i.test(s)) sk = Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));
  else {
    let d: ReturnType<typeof nip19.decode> | undefined;
    try {
      d = nip19.decode(s);
    } catch {
      /* handled below */
    }
    if (d?.type !== "nsec") throw new Error("Enter an nsec… or 64-char hex private key");
    sk = d.data;
  }
  try {
    return await loginWithSigner({ signEvent: async (t) => finalizeEvent(t, sk) });
  } finally {
    sk.fill(0);
  }
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
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
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

/** Throws HttpError code `reauth_required` when the session is not fresh and no password was given. */
export async function registerPasskey(name: string, currentPassword?: string) {
  const { startRegistration } = await import("@simplewebauthn/browser");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const optionsJSON = await api.post<any>("/auth/passkey/register/options", currentPassword ? { currentPassword } : {});
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
  // nothing cached by an earlier session (possibly another admin's, with other permissions) may carry over
  queryClient.clear();
  resetPluginUis();
  if (res?.me) queryClient.setQueryData(["me"], res.me);
  else queryClient.invalidateQueries({ queryKey: ["me"] });
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}
