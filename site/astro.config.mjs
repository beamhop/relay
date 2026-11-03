import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://beamhop.github.io',
  base: '/relay',
  integrations: [
    starlight({
      title: 'beamhop',
      description: 'A self-hostable Nostr relay with a Blossom media server, an admin app and plugins, in one process.',
      logo: { src: './src/assets/mascot/mark.png', alt: '' },
      favicon: '/favicon.png',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/beamhop/relay' }],
      editLink: { baseUrl: 'https://github.com/beamhop/relay/edit/main/site/' },
      lastUpdated: true,
      customCss: [
        '@fontsource-variable/nunito',
        '@fontsource-variable/jetbrains-mono',
        './src/styles/theme.css',
      ],
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'Install & deploy', items: [{ autogenerate: { directory: 'deploy' } }] },
        { label: 'Configuration', items: [{ autogenerate: { directory: 'config' } }] },
        { label: 'Admin app', items: [{ autogenerate: { directory: 'admin' } }] },
        { label: 'Plugins & API', items: [{ autogenerate: { directory: 'build' } }] },
      ],
    }),
  ],
});
