/**
 * NIP-05: Mapping Nostr keys to DNS-based internet identifiers.
 *
 * Serves `GET /.well-known/nostr.json?name=<local-part>` with the standard
 * `{ "names": { ... }, "relays": { ... } }` shape and permissive CORS (the spec
 * requires `Access-Control-Allow-Origin: *`). The relay acts as the identity
 * provider for a configured set of names.
 *
 * Lookups are case-insensitive on the local part (clients normalize), and a
 * query without `name` returns the full directory. An unknown name yields an
 * empty `{ "names": {} }` (HTTP 200), which is how NIP-05 clients detect "no
 * such user".
 */
import type { NostrPlugin, PluginContext } from "../plugin.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export interface Nip05Options {
  /** Map of local-part name -> 32-byte hex pubkey. Names are matched case-insensitively. */
  names: Record<string, string>;
  /** Optional map of hex pubkey -> recommended relay URLs, echoed under `relays`. */
  relays?: Record<string, string[]>;
}

/** Build the nostr.json body for an optional `name` query (case-insensitive). */
export function buildDirectory(
  opts: Nip05Options,
  name: string | null,
): { names: Record<string, string>; relays?: Record<string, string[]> } {
  // Normalize the configured names to lowercase keys once.
  const lowered: Record<string, string> = {};
  for (const key in opts.names) lowered[key.toLowerCase()] = opts.names[key]!;

  let names: Record<string, string>;
  if (name === null) {
    names = { ...opts.names };
  } else {
    const pubkey = lowered[name.toLowerCase()];
    names = pubkey ? { [name]: pubkey } : {};
  }

  if (!opts.relays) return { names };
  // Only include relay entries for pubkeys we're returning.
  const relays: Record<string, string[]> = {};
  for (const pubkey of Object.values(names)) {
    if (opts.relays[pubkey]) relays[pubkey] = opts.relays[pubkey]!;
  }
  return { names, relays };
}

export function nip05(opts: Nip05Options): NostrPlugin {
  return {
    name: "nip05",
    supportedNips: [5],

    httpRoutes: [
      {
        handle(req: Request, _ctx: PluginContext): Response | undefined {
          const url = new URL(req.url);
          if (url.pathname !== "/.well-known/nostr.json") return undefined;

          if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
          }
          if (req.method !== "GET") return undefined;

          const body = buildDirectory(opts, url.searchParams.get("name"));
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        },
      },
    ],
  };
}
