// SPDX-License-Identifier: AGPL-3.0-or-later
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false }),
    paths: { base: '/admin', relative: false },
    serviceWorker: { register: false },
    alias: {
      // The goals engine (pure functions) is shared with the server so the
      // goal sliders can preview derived limits before anything is saved.
      $goals: '../policy/src/goals.ts',
      // Single definition of the simple Settings screens (complexity budget, §6.6).
      $screens: '../experience/src/simple-screens.ts',
    },
  },
};

export default config;
