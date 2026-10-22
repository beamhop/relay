// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitepress';

// Project pages are served from /<repo>/; override with DOCS_BASE for custom domains.
export default defineConfig({
  title: 'Beamhop',
  description: 'Beamhop documentation',
  base: process.env.DOCS_BASE ?? '/relay/',
  cleanUrls: true,
  // Generated reference pages contain bare <placeholders> that Vue would parse as tags.
  markdown: { html: false },
  // Some pages link to repo files outside docs/.
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'Reference', link: '/reference/' },
      { text: 'CLI', link: '/reference/cli' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/beamhop/relay' }],
    sidebar: [
      {
        text: 'Guides',
        items: [
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Top tasks', link: '/top-tasks' },
          { text: 'Operations', link: '/operations' },
          { text: 'Enterprise', link: '/enterprise' },
          { text: 'Air-gapped', link: '/airgap' },
          { text: 'Performance', link: '/performance' },
          { text: 'Observability (OTel)', link: '/observability-otel' },
          { text: 'Usability tests', link: '/usability-tests' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Overview', link: '/reference/' },
          { text: 'Command line', link: '/reference/cli' },
          { text: 'Actions', link: '/reference/actions' },
          { text: 'Config', link: '/reference/config' },
          { text: 'Plugin SDK', link: '/reference/plugin-sdk' },
        ],
      },
    ],
  },
});
