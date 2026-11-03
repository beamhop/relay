/**
 * Boots a real beamhop (relay + Blossom + admin API + admin UI) on a free port with a throwaway data dir and a
 * freshly generated owner key. Used by the relay e2e suite (in-process) and by the admin Playwright suite (via
 * serve.ts, as a child process).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { createBeamhop, loadConfig, serve, type Beamhop, type RunningServer } from "@beamhop/server";
import { backendOverrides, releaseBackend } from "./backend";

export interface Relay {
  /** http://127.0.0.1:PORT */
  http: string;
  /** ws://127.0.0.1:PORT */
  ws: string;
  port: number;
  dir: string;
  owner: { sk: Uint8Array; skHex: string; pubkey: string; npub: string; nsec: string };
  beamhop: Beamhop;
  stop(): Promise<void>;
}

export interface StartRelayOptions {
  port?: number;
  /** deep-merged over the defaults below (highest precedence) */
  overrides?: Record<string, unknown>;
  /** reuse a fixed owner key (hex) instead of generating one */
  ownerSkHex?: string;
  /** createBeamhop extras (e.g. `pluginsEnabled` to enable plugins on first boot) */
  extras?: Record<string, unknown>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
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

export async function startRelay(opts: StartRelayOptions = {}): Promise<Relay> {
  const dir = mkdtempSync(join(tmpdir(), "beamhop-e2e-"));
  const port = opts.port ?? (await freePort());
  const sk = opts.ownerSkHex ? Uint8Array.from(Buffer.from(opts.ownerSkHex, "hex")) : generateSecretKey();
  const pubkey = getPublicKey(sk);
  const http = `http://127.0.0.1:${port}`;
  const base = {
    logLevel: "error",
    server: { host: "127.0.0.1", port, publicUrl: http },
    database: { driver: "sqlite", sqlitePath: join(dir, "e2e.db") },
    blossom: { fsPath: join(dir, "blobs") },
    admin: { owners: [pubkey] }, // hex: programmatic overrides skip the npub normalisation the CLI does
    plugins: { dir: join(dir, "plugins") },
  };
  const { config, extras } = loadConfig({ cwd: dir, env: {}, overrides: merge(merge(base, await backendOverrides(dir)), opts.overrides ?? {}) as never });
  const beamhop = await createBeamhop(config, { autoDiscoverNpm: false, extras: { ...extras, ...(opts.extras ?? {}) } as never });
  await beamhop.start();
  const server: RunningServer = await serve(beamhop, { runtime: "bun", port, host: "127.0.0.1" });
  let stopped = false;
  return {
    http,
    ws: `ws://127.0.0.1:${port}`,
    port,
    dir,
    owner: { sk, skHex: bytesToHex(sk), pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(sk) },
    beamhop,
    async stop() {
      if (stopped) return;
      stopped = true;
      server.stopAccepting();
      await beamhop.stop();
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
      await releaseBackend(dir);
    },
  };
}
