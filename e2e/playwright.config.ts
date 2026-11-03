import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3399);
// E2E_HOST=localhost serves the panel from a secure context, where the passkey specs can use WebAuthn
const HOST = process.env.E2E_HOST ?? "127.0.0.1";
export const BASE = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./admin",
  testMatch: /.*\.pw\.ts$/,
  // one shared relay: specs run one at a time so they can't race each other's moderation state
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"]],
  // per port, so concurrent runs don't clobber each other's traces
  outputDir: `test-results/${PORT}`,
  globalSetup: "./admin/global-setup.ts",
  use: {
    baseURL: `${BASE}/admin/`,
    trace: "retain-on-failure",
    // a PWA service worker that has claimed the page serves requests itself, bypassing page.route() mocks; specs
    // that test the worker opt back in with test.use({ serviceWorkers: "allow" })
    serviceWorkers: "block",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState: `.tmp/${PORT}/owner-state.json` }, testIgnore: /.*\.mobile\.pw\.ts$/ },
    { name: "mobile", use: { ...devices["Pixel 7"], storageState: `.tmp/${PORT}/owner-state.json` }, testMatch: /.*\.mobile\.pw\.ts$/ },
  ],
  webServer: {
    command: "bun harness/serve.ts",
    url: `${BASE}/admin/`,
    env: { E2E_PORT: String(PORT), E2E_HOST: HOST },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    // the default is SIGKILL, which would leave .tmp/<port> (owner key + session cookie) behind
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
