import { z } from "zod";
import { RuntimeSettingsSchema, type DeepPartial, type RuntimeSettings, type SettingsResponse } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, isZodError, zodMessage } from "../errors";
import { requirePermission } from "../middleware/auth";
import { readBody } from "../util/request";

let cachedSchema: Record<string, unknown> | undefined;
export function settingsJsonSchema(): Record<string, unknown> {
  if (!cachedSchema) {
    try {
      cachedSchema = z.toJSONSchema(RuntimeSettingsSchema as unknown as z.ZodType, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    } catch {
      cachedSchema = {};
    }
  }
  return cachedSchema;
}

const PatchSchema = z.record(z.string(), z.unknown());

/** Rejects unknown top-level sections and word-filter regexes that don't compile. */
function validatePatch(patch: Record<string, unknown>) {
  const known = Object.keys((RuntimeSettingsSchema as unknown as z.ZodObject).shape);
  const unknown = Object.keys(patch).filter((k) => !known.includes(k));
  if (unknown.length) throw badRequest(`unknown settings section: ${unknown.join(", ")}`, "validation");
  const filters = (patch.moderation as { wordFilters?: unknown } | undefined)?.wordFilters;
  if (!Array.isArray(filters)) return;
  for (const f of filters as { isRegex?: unknown; pattern?: unknown }[]) {
    if (!f?.isRegex || typeof f.pattern !== "string") continue;
    try {
      new RegExp(f.pattern, "iu");
    } catch (err) {
      throw badRequest(`invalid word filter regex "${f.pattern}": ${(err as Error).message}`, "validation");
    }
  }
}

export function registerSettingsRoutes(app: AdminApp, ctx: ApiContext) {
  const { settings } = ctx.deps;

  app.get("/settings", requirePermission("settings.view"), (c) => {
    const body: SettingsResponse = { settings: settings.get(), schema: settingsJsonSchema() };
    return c.json(body);
  });

  app.patch("/settings", requirePermission("settings.edit"), async (c) => {
    const raw = await readBody(c, PatchSchema);
    validatePatch(raw);
    const patch = raw as DeepPartial<RuntimeSettings>;
    let updated: RuntimeSettings;
    try {
      updated = await settings.update(patch, principalOf(c).pubkey);
    } catch (err) {
      throw badRequest(isZodError(err) ? zodMessage(err) : (err as Error).message || "invalid settings", "validation");
    }
    await ctx.audit(c, "settings.update", null, { patch });
    const body: SettingsResponse = { settings: updated, schema: settingsJsonSchema() };
    return c.json(body);
  });
}
