import { z } from "zod";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { readBody } from "../util/request";

const SettingsPatch = z.object({ values: z.record(z.string(), z.unknown()) });
const PLUGIN_PREFIX = "/plugins/x";
const STRIPPED_HEADERS = ["cookie", "authorization", "x-beamhop-admin-pubkey", "x-beamhop-admin-role"];

export function registerPluginRoutes(app: AdminApp, ctx: ApiContext) {
  const { plugins } = ctx.deps;
  const find = (name: string) => {
    const p = plugins.list().find((x) => x.name === name);
    if (!p) throw notFound("plugin not found");
    return p;
  };

  // Plugin admin routes: forwarded to plugins.adminRoutes with path rewritten to /:pluginName/*
  app.all(`${PLUGIN_PREFIX}/*`, requirePermission("plugins.use"), async (c) => {
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
  });

  app.get("/plugins", requirePermission("plugins.view"), (c) => c.json({ items: plugins.list() }));

  app.post("/plugins/:name/enable", requirePermission("plugins.manage"), async (c) => {
    const name = find(c.req.param("name")).name;
    await plugins.enable(name, principalOf(c).pubkey);
    await ctx.audit(c, "plugin.enable", name);
    return c.json(find(name));
  });

  app.post("/plugins/:name/disable", requirePermission("plugins.manage"), async (c) => {
    const name = find(c.req.param("name")).name;
    await plugins.disable(name, principalOf(c).pubkey);
    await ctx.audit(c, "plugin.disable", name);
    return c.json(find(name));
  });

  app.get("/plugins/:name/settings", requirePermission("plugins.view"), async (c) => {
    const info = find(c.req.param("name"));
    return c.json({ values: await plugins.getSettings(info.name), schema: info.settingsSchema ?? {} });
  });

  app.patch("/plugins/:name/settings", requirePermission("plugins.manage"), async (c) => {
    const info = find(c.req.param("name"));
    const { values } = await readBody(c, SettingsPatch);
    let saved: Record<string, unknown>;
    try {
      saved = await plugins.updateSettings(info.name, values, principalOf(c).pubkey);
    } catch (err) {
      throw badRequest((err as Error).message || "invalid plugin settings", "validation");
    }
    await ctx.audit(c, "plugin.settings", info.name, { values });
    return c.json({ values: saved, schema: info.settingsSchema ?? {} });
  });
}
