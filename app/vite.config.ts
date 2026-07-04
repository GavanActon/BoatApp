import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH lets the same build target GitHub Pages project sites (e.g. /BoatApp/)
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Sandies — Lake Superior Chartplotter',
        short_name: 'Sandies',
        description:
          'Offline depth charts, GPS tracking, and wind & wave forecasts for Whitefish Bay, Lake Superior',
        theme_color: '#0a1522',
        background_color: '#0a1522',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Chart data files are huge and managed by the in-app Offline Manager (OPFS),
        // never by the service worker precache.
        globIgnores: ['data/**', 'fonts/**', 'sprites/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/fonts\/.+\.pbf$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'glyphs',
              expiration: { maxEntries: 600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/sprites\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'sprites',
              expiration: { maxEntries: 40 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.openseamap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'seamarks',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 120 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
