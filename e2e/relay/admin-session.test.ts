/** Admin auth: NIP-98 rules, /auth/nostr challenge login → cookie session, CSRF, logout; SSE /stream. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { finalizeEvent } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, now } from "../harness/client";
import { api, nip98, signEvent, SseClient, user, waitUntil } from "./admin-helpers";

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => relay?.stop());

const A = (p: string) => `${relay.http}/admin/api${p}`;

async function challenge() {
  const r = await fetch(A("/auth/challenge"));
  expect(r.status).toBe(200);
  return (await r.json()) as { challenge: string; url: string; expiresAt: number };
}
function loginEvent(sk: Uint8Array, ch: { challenge: string; url: string }, over: { url?: string; method?: string; createdAt?: number } = {}) {
  return finalizeEvent(
    {
      kind: 27235,
      created_at: over.createdAt ?? now(),
      content: "",
      tags: [["u", over.url ?? ch.url], ["method", over.method ?? "POST"], ["challenge", ch.challenge]],
    },
    sk,
  );
}
async function postLogin(event: unknown, headers: Record<string, string> = { "X-Requested-With": "beamhop" }) {
  return fetch(A("/auth/nostr"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ event }) });
}
/** logs in and returns the bh_session cookie pair */
async function login(sk: Uint8Array): Promise<string> {
  const res = await postLogin(loginEvent(sk, await challenge()));
  expect(res.status).toBe(200);
  const set = res.headers.get("set-cookie") ?? "";
  const m = /bh_session=([^;]+)/.exec(set);
  expect(m).not.toBeNull();
  return `bh_session=${m![1]}`;
}
const withCookie = (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(A(path), {
    method,
    headers: { Cookie: cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("NIP-98", () => {
  test("a header can't be replayed", async () => {
    const url = A("/auth/me");
    const h = nip98(relay.owner.sk, url, "GET");
    expect((await fetch(url, { headers: { Authorization: h } })).status).toBe(200);
    const again = await fetch(url, { headers: { Authorization: h } });
    expect(again.status).toBe(401);
    expect((await again.json()).code).toBe("replayed_auth");
  });

  test("url, method, age, signature and payload are all checked", async () => {
    const url = A("/auth/me");
    const sk = relay.owner.sk;
    const wrongUrl = await fetch(url, { headers: { Authorization: nip98(sk, A("/users"), "GET") } });
    expect(wrongUrl.status).toBe(401);
    expect((await wrongUrl.json()).error).toBe("auth event url mismatch");
    const wrongMethod = await fetch(url, { headers: { Authorization: nip98(sk, url, "POST") } });
    expect((await wrongMethod.json()).error).toBe("auth event method mismatch");
    const old = finalizeEvent({ kind: 27235, created_at: now() - 300, content: "", tags: [["u", url], ["method", "GET"]] }, sk);
    const oldRes = await fetch(url, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(old)).toString("base64")}` } });
    expect((await oldRes.json()).error).toBe("auth event expired or from the future");
    expect((await fetch(url, { headers: { Authorization: "Nostr !!!" } })).status).toBe(401);
    // payload tag must match the body
    const body = JSON.stringify({ info: { contact: "x" } });
    const bad = await fetch(A("/settings"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: nip98(sk, A("/settings"), "PATCH", "different body") },
      body,
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe("auth event payload mismatch");
  });

  test("NIP-98 mutations don't need the CSRF header", async () => {
    const body = JSON.stringify({ info: { contact: "nip98@example" } });
    const r = await fetch(A("/settings"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: nip98(relay.owner.sk, A("/settings"), "PATCH", body) },
      body,
    });
    expect(r.status).toBe(200);
    expect((await r.json()).settings.info.contact).toBe("nip98@example");
  });
});

describe("challenge login and cookie sessions", () => {
  test("login sets an httpOnly SameSite=Strict cookie scoped to /admin; /auth/me works with it", async () => {
    const res = await postLogin(loginEvent(relay.owner.sk, await challenge()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.me.pubkey).toBe(relay.owner.pubkey);
    expect(body.me.role).toBe("owner");
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/admin");
    const cookie = `bh_session=${/bh_session=([^;]+)/.exec(set)![1]}`;
    const me = await withCookie(cookie, "GET", "/auth/me");
    expect(me.status).toBe(200);
    expect((await me.json()).pubkey).toBe(relay.owner.pubkey);
  });

  test("challenge is single-use; a forged/expired/foreign challenge is refused; non-admins can't log in", async () => {
    const ch = await challenge();
    const ev = loginEvent(relay.owner.sk, ch);
    expect((await postLogin(ev)).status).toBe(200);
    const reused = await postLogin(loginEvent(relay.owner.sk, ch));
    expect(reused.status).toBe(401);
    expect((await reused.json()).code).toBe("invalid_challenge");
    const forged = await postLogin(loginEvent(relay.owner.sk, { ...ch, challenge: "1.abc.def" }));
    expect((await forged.json()).code).toBe("invalid_challenge");
    const wrongUrl = await postLogin(loginEvent(relay.owner.sk, await challenge(), { url: "https://evil.example/admin/api/auth/nostr" }));
    expect(wrongUrl.status).toBe(401);
    const stranger = await postLogin(loginEvent(user().sk, await challenge()));
    expect(stranger.status).toBe(403);
    expect((await stranger.json()).code).toBe("not_admin");
    expect((await postLogin({ not: "an event" })).status).toBe(400);
  });

  test("login itself needs the CSRF header (or our Origin)", async () => {
    const noHeader = await postLogin(loginEvent(relay.owner.sk, await challenge()), {});
    expect(noHeader.status).toBe(403);
    expect((await noHeader.json()).code).toBe("csrf");
    const foreign = await postLogin(loginEvent(relay.owner.sk, await challenge()), { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const ours = await postLogin(loginEvent(relay.owner.sk, await challenge()), { Origin: new URL(relay.http).origin });
    expect(ours.status).toBe(200);
  });

  test("CSRF: cookie mutations without X-Requested-With are refused; with it (or our Origin) they pass", async () => {
    const cookie = await login(relay.owner.sk);
    const patch = { info: { contact: "csrf@example" } };
    const bare = await withCookie(cookie, "PATCH", "/settings", patch);
    expect(bare.status).toBe(403);
    expect((await bare.json()).code).toBe("csrf");
    const evil = await withCookie(cookie, "PATCH", "/settings", patch, { Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const ok = await withCookie(cookie, "PATCH", "/settings", patch, { "X-Requested-With": "beamhop" });
    expect(ok.status).toBe(200);
    const origin = await withCookie(cookie, "PATCH", "/settings", { info: { contact: "o@example" } }, { Origin: new URL(relay.http).origin });
    expect(origin.status).toBe(200);
    // reads need no header
    expect((await withCookie(cookie, "GET", "/settings")).status).toBe(200);
    // form-encoded bodies are refused even with the header
    const form = await fetch(A("/settings"), {
      method: "PATCH",
      headers: { Cookie: cookie, "X-Requested-With": "beamhop", "Content-Type": "application/x-www-form-urlencoded" },
      body: "info=1",
    });
    expect(form.status).toBe(415);
  });

  test("logout destroys the session and is audited", async () => {
    const cookie = await login(relay.owner.sk);
    const out = await withCookie(cookie, "POST", "/auth/logout", undefined, { "X-Requested-With": "beamhop" });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("bh_session=;");
    const me = await withCookie(cookie, "GET", "/auth/me");
    expect(me.status).toBe(401);
    const audit = await api(relay.http, relay.owner.sk, "GET", "/audit?action=auth.logout");
    expect(audit.body.items[0]).toMatchObject({ actor: relay.owner.pubkey, target: relay.owner.pubkey });
  });

  test("removing a role ends that admin's sessions", async () => {
    const m = user();
    await api(relay.http, relay.owner.sk, "PUT", `/users/${m.pubkey}/role`, { role: "moderator" });
    const cookie = await login(m.sk);
    expect((await withCookie(cookie, "GET", "/users")).status).toBe(200);
    await api(relay.http, relay.owner.sk, "PUT", `/users/${m.pubkey}/role`, { role: null });
    expect((await withCookie(cookie, "GET", "/users")).status).toBe(401);
  });

  test("garbage session cookie is treated as anonymous", async () => {
    const r = await withCookie("bh_session=deadbeef", "GET", "/auth/me");
    expect(r.status).toBe(401);
  });
});

describe("SSE /stream", () => {
  test("sends a snapshot, then live accepted and rejected events filtered by kind", async () => {
    const url = A("/stream?events=1&kinds=1");
    const sse = await SseClient.open(url, { Authorization: nip98(relay.owner.sk, url, "GET") });
    try {
      expect(sse.status).toBe(200);
      const snap = await sse.waitFor((f) => f.event === "snapshot");
      expect(typeof snap.data.connections).toBe("number");
      const c = await RelayClient.connect(relay.ws);
      const u = user();
      const ev = signEvent(u.sk, { kind: 1, content: "live!" });
      const reaction = signEvent(u.sk, { kind: 7, content: "+" });
      expect((await c.publish(reaction)).ok).toBe(true);
      expect((await c.publish(ev)).ok).toBe(true);
      const live = await sse.waitFor((f) => f.event === "event" && f.data.event.id === ev.id);
      expect(live.data.status).toBe("accepted");
      expect(live.data.ip).toBe("127.0.0.1"); // owners see IPs
      // rejected events are streamed too
      await api(relay.http, relay.owner.sk, "POST", `/users/${u.pubkey}/ban`, {});
      const rej = signEvent(u.sk, { kind: 1, content: "nope" });
      expect((await c.publish(rej)).ok).toBe(false);
      const r = await sse.waitFor((f) => f.event === "event" && f.data.event.id === rej.id);
      expect(r.data.status).toBe("rejected");
      expect(r.data.reason).toContain("banned");
      expect(sse.frames.some((f) => f.event === "event" && f.data.event.id === reaction.id)).toBe(false);
      c.close();
    } finally {
      sse.close();
    }
  });

  test("new reports are pushed live to staff who can see reports", async () => {
    const url = A("/stream");
    const sse = await SseClient.open(url, { Authorization: nip98(relay.owner.sk, url, "GET") });
    try {
      const c = await RelayClient.connect(relay.ws);
      const target = user();
      const report = signEvent(user().sk, { kind: 1984, content: "live report", tags: [["p", target.pubkey, "spam"]] });
      expect((await c.publish(report)).ok).toBe(true);
      const f = await sse.waitFor((x) => x.event === "report" && x.data.id === report.id);
      expect(f.data).toMatchObject({ targetPubkey: target.pubkey, type: "spam", status: "open" });
      // without ?events=1 no event frames
      expect(sse.frames.some((x) => x.event === "event")).toBe(false);
      c.close();
    } finally {
      sse.close();
    }
  });

  test("works with a session cookie; anonymous and bad params are refused", async () => {
    const cookie = await login(relay.owner.sk);
    const sse = await SseClient.open(A("/stream"), { Cookie: cookie });
    try {
      expect(sse.status).toBe(200);
      await sse.waitFor((f) => f.event === "snapshot");
    } finally {
      sse.close();
    }
    expect((await fetch(A("/stream"))).status).toBe(401);
    const bad = A("/stream?kinds=a,b");
    expect((await fetch(bad, { headers: { Authorization: nip98(relay.owner.sk, bad, "GET") } })).status).toBe(400);
  });

  test("viewer streams don't carry IPs; the stream ends after logout", async () => {
    const v = user();
    await api(relay.http, relay.owner.sk, "PUT", `/users/${v.pubkey}/role`, { role: "viewer" });
    const cookie = await login(v.sk);
    const sse = await SseClient.open(A("/stream?events=1"), { Cookie: cookie });
    try {
      expect(sse.status).toBe(200);
      const c = await RelayClient.connect(relay.ws);
      const ev = signEvent(user().sk, { kind: 1, content: "for viewer" });
      await c.publish(ev);
      const f = await sse.waitFor((x) => x.event === "event" && x.data.event.id === ev.id);
      expect(f.data.ip).toBeUndefined();
      c.close();
      await withCookie(cookie, "POST", "/auth/logout", undefined, { "X-Requested-With": "beamhop" });
      // the auth re-check runs every snapshot interval (2 s)
      await waitUntil(async () => sse.ended, 7000);
    } finally {
      sse.close();
    }
  }, 15000);
});
