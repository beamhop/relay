import { z } from "zod";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, notFound } from "../errors";
import type { MiddlewareHandler } from "hono";
import type { AdminContext, AdminEnv } from "../context";
import { assertPermission, requirePermission } from "../middleware/auth";
import { readBody } from "../util/request";
import { maskSecretValues } from "@beamhop/sdk/secrets";

const SettingsPatch = z.object({ values: z.record(z.string(), z.unknown()) });
const PROXY_SEGMENT = "x";
const PLUGIN_PREFIX = `/plugins/${PROXY_SEGMENT}`;
const STRIPPED_HEADERS = ["cookie", "authorization", "x-beamhop-admin-pubkey", "x-beamhop-admin-role"];
const MASK = "••••••••";

/** Every non-empty string at any depth becomes the mask; structure, numbers and flags stay. */
const maskAll = (v: unknown): unknown => {
  if (typeof v === "string") return v === "" ? v : MASK;
  if (Array.isArray(v)) return v.map(maskAll);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAll(x)]));
  return v;
};

/**
 * Masks secrets at any depth for viewers and the audit log: everything under a field the settings schema marks
 * secret (`format: "password"`, `writeOnly`, `x-secret` — through nullable/union branches and `$ref`s too) or whose
 * name looks like a credential, plus any string that carries a credential on its own. Numbers and flags stay
 * readable. The walker is shared with the server (`maskSecretValues` in @beamhop/sdk).
 */
export function maskSecrets(value: unknown, schema?: unknown): unknown {
  return maskSecretValues(value, schema, maskAll);
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
    try {
      await plugins.enable(name, principalOf(c).pubkey);
    } finally {
      // the one audit record of the attempt (the plugin manager doesn't record its own): a failed setup is audited too
      const p = find(name);
      await ctx.audit(c, "plugin.enable", name, { status: p.status, ...(p.error ? { error: p.error } : {}) });
    }
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
    return c.json({ values: canManage ? values : maskSecrets(values, info.settingsSchema), schema: info.settingsSchema ?? {} });
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
    await ctx.audit(c, "plugin.settings", info.name, { values: maskSecrets(values, info.settingsSchema) });
    return c.json({ values: saved, schema: info.settingsSchema ?? {} });
  });

  app.all(`${PLUGIN_PREFIX}/*`, (c) => proxy(c));
}
