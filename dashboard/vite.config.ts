import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');

export default defineConfig({
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  plugins: [
    react(),
    VitePWA({
      devOptions: { enabled: false },
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'Bitazza Help Desk',
        short_name: 'HelpDesk',
        description: 'Bitazza CS Agent Dashboard',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'landscape',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            // All API calls must hit the network — never serve stale data to CS agents
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 3002,
    watch: {
      ignored: ['**/dist/**', '**/node_modules/**'],
    },
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/uploads': 'http://127.0.0.1:4000',
      '/socket.io': {
        target: 'http://127.0.0.1:4000',
        ws: true,
      },
    },
  },
});
