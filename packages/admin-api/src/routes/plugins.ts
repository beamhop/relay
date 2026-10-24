import { z } from "zod";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, notFound } from "../errors";
import type { MiddlewareHandler } from "hono";
import type { AdminContext, AdminEnv } from "../context";
import { assertPermission, requirePermission } from "../middleware/auth";
import { readBody } from "../util/request";
import { isSecretKeyName, looksLikeSecretValue } from "@beamhop/sdk";

const SettingsPatch = z.object({ values: z.record(z.string(), z.unknown()) });
const PROXY_SEGMENT = "x";
const PLUGIN_PREFIX = `/plugins/${PROXY_SEGMENT}`;
const STRIPPED_HEADERS = ["cookie", "authorization", "x-beamhop-admin-pubkey", "x-beamhop-admin-role"];
const MASK = "••••••••";

type JsonSchema = {
  format?: string;
  writeOnly?: boolean;
  "x-secret"?: boolean;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
};

export { isSecretKeyName } from "@beamhop/sdk";

const isSecretProp = (key: string, p: JsonSchema | undefined) =>
  p?.format === "password" || p?.writeOnly === true || p?.["x-secret"] === true || isSecretKeyName(key);

/** Every non-empty string at any depth becomes the mask; structure, numbers and flags stay. */
const maskAll = (v: unknown): unknown => {
  if (typeof v === "string") return v === "" ? v : MASK;
  if (Array.isArray(v)) return v.map(maskAll);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAll(x)]));
  return v;
};

/**
 * Masks secrets at any depth: everything under a key that is secret by schema (`format: "password"`,
 * `writeOnly`, `x-secret`) or by name (see `isSecretKeyName`), plus any string that carries a credential on its
 * own (URLs with `user:pass@` or `secret=`/`token=` parameters, nsec keys). Numbers and flags stay readable.
 */
export function maskSecrets(value: unknown, schema?: JsonSchema): unknown {
  if (typeof value === "string") return value !== "" && looksLikeSecretValue(value) ? MASK : value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, schema?.items));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const extra = schema?.additionalProperties;
    const p = schema?.properties?.[k] ?? (extra && typeof extra === "object" ? extra : undefined);
    out[k] = isSecretProp(k, p) ? maskAll(v) : maskSecrets(v, p);
  }
  return out;
}

export function registerPluginRoutes(app: AdminApp, ctx: ApiContext) {
  const { plugins } = ctx.deps;
  const find = (name: string) => {
    const p = plugins.list().find((x) => x.name === name);
    if (!p) throw notFound("plugin not found");
    return p;
  };

  /**
   * The management routes below share their shape with the proxy (`/plugins/x/<plugin>/…`): for a plugin
   * literally named "x", `/plugins/x/enable` must reach management, not the proxy. So these routes are
   * registered first and only fall through to the proxy when `:name` is "x" and no such plugin exists.
   */
  const manage = (perm: "plugins.view" | "plugins.manage"): MiddlewareHandler<AdminEnv> => async (c, next) => {
    const name = c.req.param("name");
    if (name === PROXY_SEGMENT && !plugins.list().some((x) => x.name === name)) return proxy(c);
    assertPermission(c, perm);
    await next();
  };

  // Plugin admin routes: forwarded to plugins.adminRoutes with path rewritten to /:pluginName/*
  const proxy = async (c: AdminContext): Promise<Response> => {
    assertPermission(c, "plugins.use");
    const p = principalOf(c);
    const url = new URL(c.req.url);
    const idx = url.pathname.indexOf(`${PLUGIN_PREFIX}/`);
    url.pathname = url.pathname.slice(idx + PLUGIN_PREFIX.length) || "/";
    const headers = new Headers(c.req.raw.headers);
    for (const h of STRIPPED_HEADERS) headers.delete(h);
    headers.set("x-beamhop-admin-pubkey", p.pubkey);
    headers.set("x-beamhop-admin-role", p.role ?? "");
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    const init: RequestInit & { duplex?: "half" } = {
      method: c.req.method,
      headers,
      signal: c.req.raw.signal,
      ...(hasBody ? { body: c.req.raw.body, duplex: "half" } : {}),
    };
    return plugins.adminRoutes.fetch(new Request(url, init), c.env);
  };

  app.get("/plugins", requirePermission("plugins.view"), (c) => c.json({ items: plugins.list() }));

  app.post("/plugins/:name/enable", manage("plugins.manage"), async (c) => {
    const name = find(c.req.param("name")).name;
    await plugins.enable(name, principalOf(c).pubkey);
    await ctx.audit(c, "plugin.enable", name);
    return c.json(find(name));
  });

  app.post("/plugins/:name/disable", manage("plugins.manage"), async (c) => {
    const name = find(c.req.param("name")).name;
    await plugins.disable(name, principalOf(c).pubkey);
    await ctx.audit(c, "plugin.disable", name);
    return c.json(find(name));
  });

  app.get("/plugins/:name/settings", manage("plugins.view"), async (c) => {
    const info = find(c.req.param("name"));
    const values = await plugins.getSettings(info.name);
    const canManage = principalOf(c).permissions.has("plugins.manage");
    return c.json({ values: canManage ? values : maskSecrets(values, info.settingsSchema as JsonSchema), schema: info.settingsSchema ?? {} });
  });

  app.patch("/plugins/:name/settings", manage("plugins.manage"), async (c) => {
    const info = find(c.req.param("name"));
    const { values } = await readBody(c, SettingsPatch);
    let saved: Record<string, unknown>;
    try {
      saved = await plugins.updateSettings(info.name, values, principalOf(c).pubkey);
    } catch (err) {
      throw badRequest((err as Error).message || "invalid plugin settings", "validation");
    }
    // the audit log is readable with audit.view, so secrets never go into it
    await ctx.audit(c, "plugin.settings", info.name, { values: maskSecrets(values, info.settingsSchema as JsonSchema) });
    return c.json({ values: saved, schema: info.settingsSchema ?? {} });
  });

  app.all(`${PLUGIN_PREFIX}/*`, (c) => proxy(c));
}
