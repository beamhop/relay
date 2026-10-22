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

export function registerSettingsRoutes(app: AdminApp, ctx: ApiContext) {
  const { settings } = ctx.deps;

  app.get("/settings", requirePermission("settings.view"), (c) => {
    const body: SettingsResponse = { settings: settings.get(), schema: settingsJsonSchema() };
    return c.json(body);
  });

  app.patch("/settings", requirePermission("settings.edit"), async (c) => {
    const patch = (await readBody(c, PatchSchema)) as DeepPartial<RuntimeSettings>;
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
