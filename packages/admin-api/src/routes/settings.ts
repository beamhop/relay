import { z } from "zod";
import { unsafeRegexReason } from "@beamhop/sdk/regex-safety";
import { RuntimeSettingsSchema, type DeepPartial, type RuntimeSettings, type SettingsResponse } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, isZodError, zodMessage } from "../errors";
import { requirePermission } from "../middleware/auth";
import { tryParsePubkey } from "../util/pubkey";
import { readBody } from "../util/request";

const PatchSchema = z.record(z.string(), z.unknown());

/** Rejects unknown top-level sections and word-filter regexes that don't compile or could backtrack catastrophically. */
function validatePatch(patch: Record<string, unknown>) {
  const known = Object.keys((RuntimeSettingsSchema as unknown as z.ZodObject).shape);
  const unknown = Object.keys(patch).filter((k) => !known.includes(k));
  if (unknown.length) throw badRequest(`unknown settings section: ${unknown.join(", ")}`, "validation");
  const filters = (patch.moderation as { wordFilters?: unknown } | undefined)?.wordFilters;
  if (!Array.isArray(filters)) return;
  for (const f of filters as { isRegex?: unknown; pattern?: unknown }[]) {
    if (!f?.isRegex || typeof f.pattern !== "string") continue;
    const reason = unsafeRegexReason(f.pattern);
    if (reason) throw badRequest(`invalid word filter regex "${f.pattern}": ${reason}`, "validation");
  }
}

/**
 * Pubkey-valued settings are stored as lowercase hex, whatever spelling (npub, nprofile, uppercase hex) was sent: NIP-11
 * advertises info.pubkey as is, and retention compares exemptPubkeys with event authors byte for byte (an npub there
 * would exempt nobody). Anything that isn't a pubkey is refused. Mutates `patch`.
 */
function normalizePubkeys(patch: Record<string, unknown>) {
  const hex = (v: unknown, field: string) => {
    const pk = typeof v === "string" ? tryParsePubkey(v) : undefined;
    if (!pk) throw badRequest(`${field}: invalid pubkey (expected hex or npub)`, "validation");
    return pk;
  };
  const info = patch.info as Record<string, unknown> | undefined;
  // "" clears it
  if (info && typeof info === "object" && typeof info.pubkey === "string") info.pubkey = info.pubkey.trim() ? hex(info.pubkey, "info.pubkey") : "";
  const rules = (patch.retention as { rules?: unknown } | undefined)?.rules;
  if (!Array.isArray(rules)) return;
  rules.forEach((r: { exemptPubkeys?: unknown }, i) => {
    if (r && typeof r === "object" && Array.isArray(r.exemptPubkeys)) {
      r.exemptPubkeys = [...new Set(r.exemptPubkeys.map((v, j) => hex(v, `retention.rules.${i}.exemptPubkeys.${j}`)))];
    }
  });
}

export function registerSettingsRoutes(app: AdminApp, ctx: ApiContext) {
  const { settings } = ctx.deps;

  app.get("/settings", requirePermission("settings.view"), (c) => {
    const body: SettingsResponse = { settings: settings.get() };
    return c.json(body);
  });

  app.patch("/settings", requirePermission("settings.edit"), async (c) => {
    const raw = await readBody(c, PatchSchema);
    validatePatch(raw);
    normalizePubkeys(raw);
    const patch = raw as DeepPartial<RuntimeSettings>;
    let updated: RuntimeSettings;
    try {
      updated = await settings.update(patch, principalOf(c).pubkey);
    } catch (err) {
      throw badRequest(isZodError(err) ? zodMessage(err) : (err as Error).message || "invalid settings", "validation");
    }
    await ctx.audit(c, "settings.update", null, { patch });
    const body: SettingsResponse = { settings: updated };
    return c.json(body);
  });
}
