import { isBun, type SystemInfo } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { requirePermission } from "../middleware/auth";

export function registerSystemRoutes(app: AdminApp, ctx: ApiContext) {
  const { deps } = ctx;
  app.get("/system", requirePermission("dashboard.view"), (c) => {
    const nips = deps.relay.nip11().supported_nips;
    const info: SystemInfo = {
      name: deps.settings.get().info.name,
      version: deps.version,
      runtime: isBun ? "bun" : "node",
      runtimeVersion: (isBun ? process.versions.bun : process.versions.node) ?? "unknown",
      uptimeSec: Math.floor(process.uptime()),
      dbDialect: deps.stores.db.dialect,
      nips: Array.isArray(nips) ? nips.filter((n): n is number => typeof n === "number") : [],
      relayPubkey: deps.relay.pubkey,
      publicUrl: ctx.publicUrl,
      blossomEnabled: !!deps.blossom,
      geoipEnabled: !!deps.config.metrics.geoipDbPath,
      otelEnabled: !!deps.config.metrics.otel.enabled,
      pushEnabled: ctx.push.enabled,
    };
    return c.json(info);
  });
}
