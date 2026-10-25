/**
 * Shared boot helper for the gap-*.test.ts suites. Mirrors e2e/harness/relay.ts but can pick the runtime adapter
 * ("bun" | "node"), pass server extras (e.g. plugins enabled on first boot) and reuse a data dir across restarts.
 * Black-box only from here on: tests talk to the result over ws/http.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { createBeamhop } from "../../packages/server/src/app";
import { loadConfig } from "../../packages/server/src/config";
import { serve } from "../../packages/server/src/server";
import { freePort } from "../harness/relay";

export interface GapRelay {
  http: string;
  ws: string;
  port: number;
  dir: string;
  runtime: "bun" | "node";
  owner: { sk: Uint8Array; pubkey: string };
  /** graceful stop, as the CLI does it (drain → relay → plugins → services → db → sockets). Keeps the dir unless `rm`. */
  stop(rm?: boolean): Promise<void>;
}

export interface GapBootOptions {
  runtime?: "bun" | "node";
  dir?: string;
  ownerSk?: Uint8Array;
  overrides?: Record<string, unknown>;
  extras?: Record<string, unknown>;
  env?: Record<string, string>;
}

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
        ? merge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

export async function bootGap(opts: GapBootOptions = {}): Promise<GapRelay> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "beamhop-e2e-gap-"));
  const port = await freePort();
  const sk = opts.ownerSk ?? generateSecretKey();
  const pubkey = getPublicKey(sk);
  const http = `http://127.0.0.1:${port}`;
  const runtime = opts.runtime ?? "bun";
  const base = {
    logLevel: "error",
    server: { host: "127.0.0.1", port, publicUrl: http },
    database: { driver: "sqlite", sqlitePath: join(dir, "e2e.db") },
    blossom: { fsPath: join(dir, "blobs") },
    admin: { owners: [pubkey] },
    plugins: { dir: join(dir, "plugins") },
  };
  const { config, extras } = loadConfig({ cwd: dir, env: opts.env ?? {}, overrides: merge(base, opts.overrides ?? {}) as never });
  const beamhop = await createBeamhop(config, { autoDiscoverNpm: false, extras: { ...extras, ...(opts.extras ?? {}) } as never });
  await beamhop.start();
  const server = await serve(beamhop, { runtime, port, host: "127.0.0.1" });
  let stopped = false;
  return {
    http,
    ws: `ws://127.0.0.1:${port}`,
    port,
    dir,
    runtime,
    owner: { sk, pubkey },
    async stop(rm = true) {
      if (!stopped) {
        stopped = true;
        await beamhop.stop({ server });
      }
      if (rm) rmSync(dir, { recursive: true, force: true });
    },
  };
}
