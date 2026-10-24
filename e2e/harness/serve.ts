/**
 * Long-running relay for the admin Playwright suite (started by playwright.config.ts `webServer`). Writes the
 * generated owner key to .tmp/owner.json so specs can sign in; the key and data dir are thrown away on exit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startRelay } from "./relay";

const port = Number(process.env.E2E_PORT ?? 3399);
// the bundled plugins, loaded the way operators do it, so plugin pages, widgets and settings are exercised for real
const PLUGINS = join(import.meta.dir, "../../plugins");
const relay = await startRelay({
  port,
  overrides: { plugins: { packages: [join(PLUGINS, "hello"), join(PLUGINS, "spam-filter")] } },
  extras: { pluginsEnabled: ["hello", "spam-filter"] },
});
const out = join(import.meta.dir, `../.tmp/${port}`); // per port: parallel runs on other ports don't collide
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "owner.json"),
  JSON.stringify({ http: relay.http, ws: relay.ws, nsec: relay.owner.nsec, npub: relay.owner.npub, skHex: relay.owner.skHex, pubkey: relay.owner.pubkey }),
);
console.log(`e2e relay ready on ${relay.http}`);
const stop = async () => {
  await relay.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
