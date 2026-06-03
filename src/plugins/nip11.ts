/**
 * NIP-11: Relay Information Document.
 *
 * Serves the relay info JSON over HTTP when the request asks for
 * `application/nostr+json`, with permissive CORS so browser clients
 * (such as iris.to) can introspect the relay. Other requests pass through
 * to the WebSocket upgrade.
 */
import type { NostrPlugin, PluginContext } from "../plugin.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/**
 * @param infoProvider returns the merged relay info document (the Relay's
 *                     `info` getter), so supported_nips reflects all plugins.
 */
export function nip11(infoProvider: () => Record<string, unknown>): NostrPlugin {
  return {
    name: "nip11",
    supportedNips: [11],

    httpRoutes: [
      {
        handle(req: Request, _ctx: PluginContext): Response | undefined {
          if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
          }
          if (req.method !== "GET") return undefined;

          const accept = req.headers.get("accept") ?? "";
          if (!accept.includes("application/nostr+json")) return undefined;

          return new Response(JSON.stringify(infoProvider()), {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/nostr+json",
            },
          });
        },
      },
    ],
  };
}
