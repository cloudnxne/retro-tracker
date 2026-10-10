import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      // Never auto-reload mid-workout; src/lib/appUpdate.ts decides when to switch.
      registerType: 'prompt',
      manifest: {
        name: 'Retro Tracker',
        short_name: 'Retro',
        description: 'Log your sets in one tap. Progression and deloads built in.',
        theme_color: '#16131A',
        background_color: '#16131A',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        // Android installs need PNGs (scripts/render-icons.mjs renders them from icon.svg). The artwork
        // sits inside the central 80%, so the same image is safe as a maskable icon.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'] },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
