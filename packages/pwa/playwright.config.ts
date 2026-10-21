// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone',
      // iPhone viewport, touch and mobile UA, rendered by Chromium (CDP touch input for swipes).
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
      testIgnore: /desktop\.e2e\.ts$/,
    },
    {
      name: 'desktop',
      // Desktop parity (§6.14): sidebar, split panes, ⌘K, keyboard shortcuts.
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
      testMatch: /desktop\.e2e\.ts$/,
    },
  ],
  webServer: {
    command: 'bun e2e/mock-server.ts',
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
