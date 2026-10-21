// SPDX-License-Identifier: AGPL-3.0-or-later
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

const testing = !!process.env.VITEST;

export default defineConfig({
  plugins: [
    tailwindcss(),
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['baseLocale'],
      emitGitIgnore: false,
    }),
    sveltekit(),
    ...(testing
      ? []
      : [
          SvelteKitPWA({
            base: '/admin/',
            scope: '/admin/',
            registerType: 'prompt',
            injectRegister: false,
            manifest: {
              name: 'Beamhop admin',
              short_name: 'Beamhop',
              description: 'Run your Nostr relay and media server from your phone.',
              start_url: '/admin/',
              scope: '/admin/',
              display: 'standalone',
              background_color: '#09090b',
              theme_color: '#09090b',
              icons: [
                { src: '/admin/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/admin/icon-512.png', sizes: '512x512', type: 'image/png' },
                {
                  src: '/admin/icon-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
            kit: {
              base: '/admin/',
              adapterFallback: 'index.html',
              spa: { fallbackMapping: 'index.html' },
            },
            workbox: {
              navigateFallback: 'index.html',
              navigateFallbackDenylist: [/\/api\//, /\/\.well-known\//],
              globPatterns: ['client/**/*.{js,css,ico,png,svg,webmanifest,woff2}'],
              importScripts: ['push-sw.js'],
            },
          }),
        ]),
  ],
});
