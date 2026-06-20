import { normalizeNipId } from "./config";
import type { ManagementState } from "./management";
import { createPluginManager, type PluginManager } from "./plugins";
import type { EventStore } from "./storage";
import type { RelayStats } from "./relayStats";
import type { ConnectionState, NipId, RelayConfig, RelayLimits, RelayMetadata } from "./types";

const SESSION_COOKIE = "relay_admin_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export interface AdminState {
  sessions: Map<string, number>;
}

export interface AdminRuntime {
  config: RelayConfig;
  store: EventStore;
  plugins: PluginManager;
  management: ManagementState;
}

export interface AdminRequestContext {
  runtime: AdminRuntime;
  stats: RelayStats;
  connections: Map<string, ConnectionState>;
  relayUrls: string[];
}

export function createAdminState(): AdminState {
  return { sessions: new Map() };
}

export async function handleAdminRequest(request: Request, state: AdminState, context: AdminRequestContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin")) return undefined;
  try {
    if (!context.runtime.config.admin.web) return textResponse("admin web interface is disabled", 404);

    if (url.pathname === "/admin" || url.pathname === "/admin/") return htmlResponse(adminPage());
    if (url.pathname === "/admin/api/login" && request.method === "POST") return handleLogin(request, state, context.runtime.config);

    const authenticated = isAuthenticated(request, state);
    if (!authenticated) return jsonResponse({ error: "unauthorized" }, 401);

    if (url.pathname === "/admin/api/logout" && request.method === "POST") return handleLogout(request, state);
    if (url.pathname === "/admin/api/status" && request.method === "GET") return jsonResponse(await adminStatus(context));
    if (url.pathname === "/admin/api/config" && request.method === "PATCH") {
      const body = await readJsonObject(request);
      updateRelayConfig(context.runtime, body);
      return jsonResponse(await adminStatus(context));
    }
    if (url.pathname === "/admin/api/rpc" && request.method === "POST") {
      const body = await readJsonObject(request);
      const method = optionalString(body.method);
      const params = Array.isArray(body.params) ? body.params : [];
      return context.runtime.management.handleRpc(method ? { method, params } : { params }, context.runtime.config);
    }

    return jsonResponse({ error: "not found" }, 404);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function handleLogin(request: Request, state: AdminState, config: RelayConfig): Promise<Response> {
  const body = await readJsonObject(request);
  const password = optionalString(body.password);
  if (!password) return jsonResponse({ error: "password is required" }, 400);
  if (!timingSafeEqual(password, config.admin.password ?? "")) return jsonResponse({ error: "invalid password" }, 401);

  const token = crypto.randomUUID();
  state.sessions.set(token, Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  return jsonResponse(
    { ok: true },
    200,
    {
      "set-cookie": `${SESSION_COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    },
  );
}

function handleLogout(request: Request, state: AdminState): Response {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) state.sessions.delete(token);
  return jsonResponse(
    { ok: true },
    200,
    {
      "set-cookie": `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  );
}

async function adminStatus(context: AdminRequestContext) {
  const { runtime, stats, connections, relayUrls } = context;
  const storedEvents = await runtime.store.count([{}]);
  const connectionList = [...connections.values()].map((connection) => ({
    id: connection.id,
    remoteAddress: connection.remoteAddress ?? "",
    authenticatedPubkeys: [...connection.authenticatedPubkeys],
    subscriptions: connection.subscriptions.size,
    negentropySubscriptions: connection.negentropySubscriptions.size,
  }));
  const activeSubscriptions = connectionList.reduce((sum, connection) => sum + connection.subscriptions, 0);
  const activeNegentropySubscriptions = connectionList.reduce((sum, connection) => sum + connection.negentropySubscriptions, 0);
  const authenticatedConnections = connectionList.filter((connection) => connection.authenticatedPubkeys.length > 0).length;

  return {
    now: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - stats.startedAtMs) / 1000),
    relayUrls,
    config: {
      host: runtime.config.host,
      port: runtime.config.port,
      relayUrl: runtime.config.relayUrl ?? "",
      persistence: runtime.config.persistence ?? "",
      relay: runtime.config.relay,
      limits: runtime.config.limits,
      requireAuthForRead: runtime.config.requireAuthForRead,
      requireAuthForWrite: runtime.config.requireAuthForWrite,
      acceptProtectedEvents: runtime.config.acceptProtectedEvents,
      disabledNips: [...runtime.config.disabledNips].sort(),
      admin: { web: runtime.config.admin.web },
    },
    plugins: {
      supportedNips: runtime.plugins.supportedNips(),
      enabled: runtime.plugins.enabled.length,
      disabled: runtime.plugins.disabled.size,
      manifest: runtime.plugins.pluginManifest(),
    },
    management: runtime.management.snapshot(),
    stats: {
      startedAt: stats.startedAt,
      connections: stats.connections,
      messages: stats.messages,
      events: stats.events,
      recent: stats.recent,
      storedEvents: storedEvents.count,
      liveConnectedPeers: connectionList.length,
      activeConnections: connectionList.length,
      authenticatedConnections,
      activeSubscriptions,
      activeNegentropySubscriptions,
    },
    connections: connectionList,
  };
}

function updateRelayConfig(runtime: AdminRuntime, body: Record<string, unknown>): void {
  const relay = isRecord(body.relay) ? body.relay : undefined;
  if (relay) updateRelayMetadata(runtime.config.relay, relay);

  const limits = isRecord(body.limits) ? body.limits : undefined;
  if (limits) updateRelayLimits(runtime.config.limits, limits);

  updateBoolean(body, "requireAuthForRead", (value) => {
    runtime.config.requireAuthForRead = value;
  });
  updateBoolean(body, "requireAuthForWrite", (value) => {
    runtime.config.requireAuthForWrite = value;
  });
  updateBoolean(body, "acceptProtectedEvents", (value) => {
    runtime.config.acceptProtectedEvents = value;
  });

  if (body.disabledNips !== undefined) {
    if (!Array.isArray(body.disabledNips)) throw new Error("disabledNips must be an array");
    runtime.config.disabledNips = new Set<NipId>(body.disabledNips.map((nip) => normalizeNipId(requireString(nip, "NIP id"))));
    runtime.plugins = createPluginManager(runtime.config);
  }
}

function updateRelayMetadata(relay: RelayMetadata, input: Record<string, unknown>): void {
  const record = relay as unknown as Record<string, string | undefined>;
  for (const key of ["name", "description", "pubkey", "self", "contact", "banner", "icon", "software", "version", "terms_of_service"]) {
    if (!(key in input)) continue;
    const value = requireString(input[key], key);
    if (value.trim() === "" && key !== "name" && key !== "description" && key !== "software" && key !== "version") {
      delete record[key];
    } else {
      record[key] = value;
    }
  }
}

function updateRelayLimits(limits: RelayLimits, input: Record<string, unknown>): void {
  const requiredLimitKeys: Array<keyof RelayLimits> = [
    "maxMessageLength",
    "maxSubscriptions",
    "maxSubIdLength",
    "maxLimit",
    "defaultLimit",
    "maxEventTags",
    "maxContentLength",
    "authEventMaxAgeSeconds",
  ];
  for (const key of requiredLimitKeys) {
    if (!(key in input)) continue;
    limits[key] = requireNonNegativeInteger(input[key], key);
  }
  for (const key of ["createdAtLowerLimit", "createdAtUpperLimit"] as const) {
    if (!(key in input)) continue;
    if (input[key] === null || input[key] === "") delete limits[key];
    else limits[key] = requireNonNegativeInteger(input[key], key);
  }
}

function updateBoolean(body: Record<string, unknown>, key: "requireAuthForRead" | "requireAuthForWrite" | "acceptProtectedEvents", update: (value: boolean) => void): void {
  if (!(key in body)) return;
  if (typeof body[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  update(body[key]);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("request body must be JSON");
  }
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  return value;
}

function isAuthenticated(request: Request, state: AdminState): boolean {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return false;
  const expiresAt = state.sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    state.sessions.delete(token);
    return false;
  }
  return true;
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const item of cookie.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return undefined;
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let i = 0; i < length; i += 1) diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  return diff === 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function adminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Beamhop Relay Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #5e6b78;
      --line: #dbe1e8;
      --accent: #14746f;
      --accent-strong: #0b5f5a;
      --danger: #b42318;
      --warn: #9a6700;
      --ok: #0f7b45;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, textarea, select { font: inherit; }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
      min-height: 36px;
    }
    button.secondary { background: #fff; color: var(--accent-strong); }
    button.danger { border-color: var(--danger); background: var(--danger); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      min-height: 36px;
    }
    textarea { resize: vertical; min-height: 76px; }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; font-weight: 600; }
    .hidden { display: none !important; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header {
      position: sticky;
      top: 0;
      z-index: 4;
      background: rgba(255, 255, 255, 0.94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    .header-inner {
      max-width: 1440px;
      margin: 0 auto;
      padding: 12px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand { display: flex; flex-direction: column; min-width: 0; }
    .brand strong { font-size: 17px; }
    .brand span { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    main {
      max-width: 1440px;
      width: 100%;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      gap: 16px;
    }
    .login {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 18px;
    }
    .login form {
      width: min(380px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 22px;
      display: grid;
      gap: 14px;
    }
    .login h1 { margin: 0; font-size: 22px; }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      background: #eef3f7;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
      letter-spacing: 0;
    }
    .panel-body { padding: 14px; display: grid; gap: 14px; }
    .span-12 { grid-column: span 12; }
    .span-8 { grid-column: span 8; }
    .span-6 { grid-column: span 6; }
    .span-4 { grid-column: span 4; }
    .metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      min-height: 74px;
      display: grid;
      align-content: space-between;
      gap: 8px;
    }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric strong { font-size: 24px; font-weight: 700; line-height: 1; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .wide { grid-column: 1 / -1; }
    .checks { display: flex; flex-wrap: wrap; gap: 12px; }
    .check { display: inline-flex; align-items: center; gap: 8px; color: var(--text); font-size: 13px; font-weight: 600; }
    .check input { width: auto; min-height: auto; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 700; background: #f9fbfc; }
    td { word-break: break-word; }
    tbody tr:last-child td { border-bottom: 0; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
    .list-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .mini-list { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .mini-list h3 { margin: 0; padding: 9px 10px; font-size: 13px; border-bottom: 1px solid var(--line); background: #f9fbfc; }
    .mini-list ul { margin: 0; padding: 0; list-style: none; max-height: 220px; overflow: auto; }
    .mini-list li { padding: 9px 10px; border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
    .mini-list li:last-child { border-bottom: 0; }
    .row-actions { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 12px; }
    .muted { color: var(--muted); }
    .error { color: var(--danger); }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    @media (max-width: 1050px) {
      .span-8, .span-6, .span-4 { grid-column: span 12; }
      .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 680px) {
      .header-inner { align-items: flex-start; flex-direction: column; }
      main { padding: 12px; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .form-grid, .list-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <section id="loginView" class="login hidden">
    <form id="loginForm">
      <h1>Beamhop Relay Admin</h1>
      <label>Password
        <input id="passwordInput" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Log in</button>
      <div id="loginError" class="error"></div>
    </form>
  </section>

  <section id="appView" class="shell hidden">
    <header>
      <div class="header-inner">
        <div class="brand">
          <strong id="relayTitle">Beamhop Relay</strong>
          <span id="relaySubtitle">Loading</span>
        </div>
        <div class="toolbar">
          <span class="status-pill"><span class="dot"></span><span id="pollStatus">Live</span></span>
          <button id="refreshButton" class="secondary" type="button">Refresh</button>
          <button id="logoutButton" class="secondary" type="button">Log out</button>
        </div>
      </div>
    </header>
    <main>
      <section class="panel span-12">
        <h2>Relay Activity</h2>
        <div class="panel-body">
          <div class="metrics">
            <div class="metric"><span>Live peers</span><strong id="statConnections">0</strong></div>
            <div class="metric"><span>Subscriptions</span><strong id="statSubscriptions">0</strong></div>
            <div class="metric"><span>Stored events</span><strong id="statStored">0</strong></div>
            <div class="metric"><span>Accepted</span><strong id="statAccepted">0</strong></div>
            <div class="metric"><span>Rejected</span><strong id="statRejected">0</strong></div>
            <div class="metric"><span>Uptime</span><strong id="statUptime">0s</strong></div>
          </div>
        </div>
      </section>

      <section class="grid">
        <section class="panel span-8">
          <h2>Runtime Configuration</h2>
          <div class="panel-body">
            <form id="configForm" class="form-grid">
              <label>Relay name<input id="relayName" name="relayName"></label>
              <label>Contact<input id="relayContact" name="relayContact"></label>
              <label class="wide">Description<textarea id="relayDescription" name="relayDescription"></textarea></label>
              <label>Icon URL<input id="relayIcon" name="relayIcon"></label>
              <label>Banner URL<input id="relayBanner" name="relayBanner"></label>
              <label>Disabled NIPs<input id="disabledNips" name="disabledNips" placeholder="50, 70"></label>
              <label>Max subscriptions<input id="maxSubscriptions" name="maxSubscriptions" type="number" min="0"></label>
              <label>Max message length<input id="maxMessageLength" name="maxMessageLength" type="number" min="0"></label>
              <label>Max event tags<input id="maxEventTags" name="maxEventTags" type="number" min="0"></label>
              <label>Max content length<input id="maxContentLength" name="maxContentLength" type="number" min="0"></label>
              <label>Default limit<input id="defaultLimit" name="defaultLimit" type="number" min="0"></label>
              <label>Max limit<input id="maxLimit" name="maxLimit" type="number" min="0"></label>
              <div class="wide checks">
                <label class="check"><input id="requireAuthForRead" type="checkbox">Require auth for reads</label>
                <label class="check"><input id="requireAuthForWrite" type="checkbox">Require auth for writes</label>
                <label class="check"><input id="acceptProtectedEvents" type="checkbox">Accept protected events</label>
              </div>
              <div class="wide actions">
                <button type="submit">Save changes</button>
                <span id="configMessage" class="muted"></span>
              </div>
            </form>
          </div>
        </section>

        <section class="panel span-4">
          <h2>Moderation</h2>
          <div class="panel-body">
            <form id="pubkeyForm" class="form-grid">
              <label class="wide">Pubkey<input id="pubkeyValue" class="mono"></label>
              <label class="wide">Reason<input id="pubkeyReason"></label>
              <div class="wide actions">
                <button data-action="banpubkey" type="button">Ban</button>
                <button data-action="allowpubkey" class="secondary" type="button">Allow</button>
              </div>
            </form>
            <form id="eventForm" class="form-grid">
              <label class="wide">Event ID<input id="eventValue" class="mono"></label>
              <label class="wide">Reason<input id="eventReason"></label>
              <div class="wide actions">
                <button data-action="banevent" class="danger" type="button">Ban event</button>
              </div>
            </form>
            <form id="ipForm" class="form-grid">
              <label>IP address<input id="ipValue"></label>
              <label>Reason<input id="ipReason"></label>
              <div class="wide actions">
                <button data-action="blockip" class="danger" type="button">Block IP</button>
              </div>
            </form>
            <form id="kindForm" class="form-grid">
              <label>Kind<input id="kindValue" type="number" min="0" max="65535"></label>
              <div class="actions">
                <button data-action="allowkind" type="button">Allow kind</button>
                <button data-action="disallowkind" class="secondary" type="button">Remove kind</button>
              </div>
            </form>
            <div id="moderationMessage" class="muted"></div>
          </div>
        </section>

        <section class="panel span-6">
          <h2>Moderation State</h2>
          <div class="panel-body">
            <div class="list-grid">
              <div class="mini-list"><h3>Banned pubkeys</h3><ul id="bannedPubkeys"></ul></div>
              <div class="mini-list"><h3>Allowed pubkeys</h3><ul id="allowedPubkeys"></ul></div>
              <div class="mini-list"><h3>Banned events</h3><ul id="bannedEvents"></ul></div>
              <div class="mini-list"><h3>Blocked IPs</h3><ul id="blockedIps"></ul></div>
              <div class="mini-list"><h3>Allowed kinds</h3><ul id="allowedKinds"></ul></div>
            </div>
          </div>
        </section>

        <section class="panel span-6">
          <h2>Connections</h2>
          <div class="panel-body">
            <div class="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Remote</th><th>Auth pubkeys</th><th>Subs</th></tr></thead>
                <tbody id="connectionsTable"></tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="panel span-12">
          <h2>Recent Activity</h2>
          <div class="panel-body">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Level</th><th>Message</th><th>Details</th></tr></thead>
                <tbody id="activityTable"></tbody>
              </table>
            </div>
          </div>
        </section>
      </section>
    </main>
  </section>

  <script>
    const app = {
      status: null,
      configLoaded: false,
      pollTimer: null
    };
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const response = await fetch('/admin' + path, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options.headers || {})
        }
      });
      if (response.status === 401) {
        showLogin();
        throw new Error('unauthorized');
      }
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error((data && data.error) || 'request failed');
      return data;
    }

    function showLogin() {
      $('appView').classList.add('hidden');
      $('loginView').classList.remove('hidden');
      clearInterval(app.pollTimer);
      app.pollTimer = null;
    }

    function showApp() {
      $('loginView').classList.add('hidden');
      $('appView').classList.remove('hidden');
      if (!app.pollTimer) app.pollTimer = setInterval(loadStatus, 2000);
    }

    async function loadStatus() {
      try {
        const status = await api('/api/status', { method: 'GET' });
        app.status = status;
        renderStatus(status);
        showApp();
      } catch (error) {
        if (String(error.message) !== 'unauthorized') $('pollStatus').textContent = 'Disconnected';
      }
    }

    function renderStatus(status) {
      $('relayTitle').textContent = status.config.relay.name || 'Beamhop Relay';
      $('relaySubtitle').textContent = 'ws://' + status.config.host + ':' + status.config.port + '/';
      $('pollStatus').textContent = 'Live';
      $('statConnections').textContent = String(status.stats.liveConnectedPeers ?? status.stats.activeConnections);
      $('statSubscriptions').textContent = String(status.stats.activeSubscriptions);
      $('statStored').textContent = String(status.stats.storedEvents);
      $('statAccepted').textContent = String(status.stats.events.accepted);
      $('statRejected').textContent = String(status.stats.events.rejected);
      $('statUptime').textContent = formatDuration(status.uptimeSeconds);
      if (!app.configLoaded) populateConfig(status.config);
      renderManagement(status.management);
      renderConnections(status.connections);
      renderActivity(status.stats.recent);
    }

    function populateConfig(config) {
      $('relayName').value = config.relay.name || '';
      $('relayContact').value = config.relay.contact || '';
      $('relayDescription').value = config.relay.description || '';
      $('relayIcon').value = config.relay.icon || '';
      $('relayBanner').value = config.relay.banner || '';
      $('disabledNips').value = config.disabledNips.join(', ');
      $('maxSubscriptions').value = config.limits.maxSubscriptions;
      $('maxMessageLength').value = config.limits.maxMessageLength;
      $('maxEventTags').value = config.limits.maxEventTags;
      $('maxContentLength').value = config.limits.maxContentLength;
      $('defaultLimit').value = config.limits.defaultLimit;
      $('maxLimit').value = config.limits.maxLimit;
      $('requireAuthForRead').checked = Boolean(config.requireAuthForRead);
      $('requireAuthForWrite').checked = Boolean(config.requireAuthForWrite);
      $('acceptProtectedEvents').checked = Boolean(config.acceptProtectedEvents);
      app.configLoaded = true;
    }

    function renderManagement(management) {
      renderRecordList('bannedPubkeys', management.bannedPubkeys, 'pubkey', 'unbanpubkey');
      renderRecordList('allowedPubkeys', management.allowedPubkeys, 'pubkey', 'unallowpubkey');
      renderRecordList('bannedEvents', management.bannedEvents, 'id', 'allowevent');
      renderRecordList('blockedIps', management.blockedIps, 'ip', 'unblockip');
      renderKindList(management.allowedKinds);
    }

    function renderRecordList(id, items, valueKey, removeMethod) {
      const list = $(id);
      list.replaceChildren();
      if (!items.length) {
        list.append(emptyItem('None'));
        return;
      }
      for (const item of items) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row-actions';
        const value = document.createElement('span');
        value.className = 'mono';
        value.textContent = item[valueKey];
        const button = document.createElement('button');
        button.className = 'secondary';
        button.type = 'button';
        button.textContent = 'Remove';
        button.dataset.rpc = removeMethod;
        button.dataset.value = item[valueKey];
        row.append(value, button);
        const reason = document.createElement('span');
        reason.className = 'muted';
        reason.textContent = item.reason || '';
        li.append(row, reason);
        list.append(li);
      }
    }

    function renderKindList(items) {
      const list = $('allowedKinds');
      list.replaceChildren();
      if (!items.length) {
        list.append(emptyItem('No kind allowlist'));
        return;
      }
      for (const kind of items) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row-actions';
        const value = document.createElement('span');
        value.textContent = String(kind);
        const button = document.createElement('button');
        button.className = 'secondary';
        button.type = 'button';
        button.textContent = 'Remove';
        button.dataset.rpc = 'disallowkind';
        button.dataset.value = String(kind);
        row.append(value, button);
        li.append(row);
        list.append(li);
      }
    }

    function emptyItem(text) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = text;
      return li;
    }

    function renderConnections(connections) {
      const table = $('connectionsTable');
      table.replaceChildren();
      if (!connections.length) {
        table.append(row(['No active connections', '', '', '']));
        return;
      }
      for (const connection of connections) {
        table.append(row([
          connection.id,
          connection.remoteAddress || '',
          connection.authenticatedPubkeys.join(', '),
          String(connection.subscriptions) + ' / ' + String(connection.negentropySubscriptions)
        ]));
      }
    }

    function renderActivity(items) {
      const table = $('activityTable');
      table.replaceChildren();
      if (!items.length) {
        table.append(row(['No activity yet', '', '', '']));
        return;
      }
      for (const item of items) {
        table.append(row([
          new Date(item.at).toLocaleTimeString(),
          item.level,
          item.message,
          item.details ? JSON.stringify(item.details) : ''
        ], item.level));
      }
    }

    function row(values, level) {
      const tr = document.createElement('tr');
      if (level) tr.className = level;
      for (const value of values) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }

    function formatDuration(seconds) {
      if (seconds < 60) return String(seconds) + 's';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return String(minutes) + 'm';
      const hours = Math.floor(minutes / 60);
      return String(hours) + 'h ' + String(minutes % 60) + 'm';
    }

    function numberValue(id) {
      const value = Number($(id).value);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(id + ' must be a non-negative integer');
      return value;
    }

    async function saveConfig(event) {
      event.preventDefault();
      $('configMessage').textContent = 'Saving';
      const disabledNips = $('disabledNips').value.split(',').map((item) => item.trim()).filter(Boolean);
      const payload = {
        relay: {
          name: $('relayName').value,
          description: $('relayDescription').value,
          contact: $('relayContact').value,
          icon: $('relayIcon').value,
          banner: $('relayBanner').value
        },
        disabledNips,
        limits: {
          maxSubscriptions: numberValue('maxSubscriptions'),
          maxMessageLength: numberValue('maxMessageLength'),
          maxEventTags: numberValue('maxEventTags'),
          maxContentLength: numberValue('maxContentLength'),
          defaultLimit: numberValue('defaultLimit'),
          maxLimit: numberValue('maxLimit')
        },
        requireAuthForRead: $('requireAuthForRead').checked,
        requireAuthForWrite: $('requireAuthForWrite').checked,
        acceptProtectedEvents: $('acceptProtectedEvents').checked
      };
      try {
        await api('/api/config', { method: 'PATCH', body: JSON.stringify(payload) });
        app.configLoaded = false;
        await loadStatus();
        $('configMessage').textContent = 'Saved';
      } catch (error) {
        $('configMessage').textContent = error.message;
      }
    }

    async function runRpc(method, params) {
      $('moderationMessage').textContent = 'Applying';
      try {
        await api('/api/rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
        await loadStatus();
        $('moderationMessage').textContent = 'Applied';
      } catch (error) {
        $('moderationMessage').textContent = error.message;
      }
    }

    document.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.rpc) {
        const value = target.dataset.value;
        const parsed = target.dataset.rpc.includes('kind') ? Number(value) : value;
        runRpc(target.dataset.rpc, [parsed]);
      }
      if (target.dataset.action === 'banpubkey') runRpc('banpubkey', [$('pubkeyValue').value, $('pubkeyReason').value]);
      if (target.dataset.action === 'allowpubkey') runRpc('allowpubkey', [$('pubkeyValue').value, $('pubkeyReason').value]);
      if (target.dataset.action === 'banevent') runRpc('banevent', [$('eventValue').value, $('eventReason').value]);
      if (target.dataset.action === 'blockip') runRpc('blockip', [$('ipValue').value, $('ipReason').value]);
      if (target.dataset.action === 'allowkind') runRpc('allowkind', [Number($('kindValue').value)]);
      if (target.dataset.action === 'disallowkind') runRpc('disallowkind', [Number($('kindValue').value)]);
    });

    $('loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('loginError').textContent = '';
      try {
        await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('passwordInput').value }) });
        app.configLoaded = false;
        await loadStatus();
      } catch (error) {
        $('loginError').textContent = error.message;
      }
    });

    $('configForm').addEventListener('submit', saveConfig);
    $('refreshButton').addEventListener('click', loadStatus);
    $('logoutButton').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST', body: '{}' });
      showLogin();
    });

    loadStatus();
  </script>
</body>
</html>`;
}
