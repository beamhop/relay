// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '@beamhop/core';
import { createBunPluginHost } from '../src/bun/index.ts';
import { bootKernel, ev, runEvent, tempDir, waitFor } from './helpers.ts';

const SDK = join(import.meta.dir, '..', 'src', 'sdk', 'index.ts');

function source(word: string): string {
  return `import { definePlugin, reject } from ${JSON.stringify(SDK)};
export default definePlugin({
  id: 'live',
  name: 'Live',
  description: 'hot reload fixture',
  version: '1.0.0',
  onEvent(event) {
    if (event.content === ${JSON.stringify(word)}) return reject('blocked', 'no ${word}');
  },
});
`;
}

let kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels) await k.use<{ stop(): Promise<void> }>('plugins')?.stop();
  kernels = [];
});

describe.each([false, true])('hot reload (trusted=%p)', (trusted) => {
  test('reloads when the file changes', async () => {
    const dir = tempDir();
    const file = join(dir, 'live.ts');
    writeFileSync(file, source('alpha'));
    const { kernel, host } = await bootKernel(
      {
        plugins: [{ id: 'live', enabled: true, config: {} }],
        modules: {
          plugins: {
            hotReload: true,
            timeBudgetMs: 500,
            entries: { live: { source: `file:${file}`, trusted } },
          },
        },
      },
      [createBunPluginHost({ dir })],
    );
    kernels.push(kernel);
    expect((await runEvent(kernel, ev('alpha'))).action).toBe('reject');
    expect((await runEvent(kernel, ev('beta'))).action).toBe('accept');

    writeFileSync(file, source('beta'));
    await waitFor(async () => (await runEvent(kernel, ev('beta'))).action === 'reject');
    expect((await runEvent(kernel, ev('alpha'))).action).toBe('accept');
    expect(host.status()[0]!.status).toBe('running');

    // A broken edit keeps the last good version running and shows the error.
    writeFileSync(file, 'export default {{{');
    await waitFor(() => !!host.status()[0]!.error);
    expect((await runEvent(kernel, ev('beta'))).action).toBe('reject');
  });
});

test('config change reloads without restart', async () => {
  const dir = tempDir();
  const file = join(dir, 'live.ts');
  writeFileSync(file, source('alpha'));
  const { kernel, host } = await bootKernel(
    {
      plugins: [{ id: 'live', enabled: false, config: {} }],
      modules: { plugins: { timeBudgetMs: 500, entries: { live: { source: file } } } },
    },
    [createBunPluginHost({ dir, watch: () => () => {} })],
  );
  kernels.push(kernel);
  expect((await runEvent(kernel, ev('alpha'))).action).toBe('accept');
  await kernel.applyConfig({
    ...kernel.config(),
    plugins: [{ id: 'live', enabled: true, config: {} }],
  });
  await waitFor(() => host.status()[0]!.status === 'running');
  expect((await runEvent(kernel, ev('alpha'))).action).toBe('reject');
});
