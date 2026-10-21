// SPDX-License-Identifier: AGPL-3.0-or-later
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: vitest ships its own vite major, so plugin types differ.
export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['baseLocale'],
      emitGitIgnore: false,
    }) as never,
    sveltekit() as never,
  ],
  test: {
    include: ['test/**/*.unit.ts'],
    environment: 'node',
  },
});
