import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Dev-only Open-Meteo cache. The app fetches `/__om/<host>/<path>?query` in
 * dev (see openMeteo.ts); this middleware forwards to the real host, keeps
 * every response on disk, and serves from disk while it's fresh. Repeated dev
 * sessions and browser-driven tests then cost one upstream fetch per unique
 * request instead of one per page load — Open-Meteo rate-limits bursts, and
 * a test run that replans a trip a few times is exactly such a burst.
 *
 * A stale file also stands in whenever the upstream fetch fails (offline,
 * 429), so dev keeps working through the rate limit it just avoided causing.
 */
function omCache(): Plugin {
  const dir = join(__dirname, '.om-cache')
  const FRESH_MS = 60 * 60_000 // forecasts update hourly; fresher is noise
  const ALLOWED = new Set(['api.open-meteo.com', 'marine-api.open-meteo.com'])
  return {
    name: 'om-cache',
    apply: 'serve',
    configureServer(server) {
      mkdirSync(dir, { recursive: true })
      server.middlewares.use('/__om', (req, res) => {
        void (async () => {
          const [path, query] = (req.url ?? '').split('?')
          const host = path.split('/')[1]
          if (!ALLOWED.has(host)) {
            res.statusCode = 403
            res.end('host not allowed')
            return
          }
          const upstream = `https://${host}${path.slice(host.length + 1)}?${query ?? ''}`
          const file = join(dir, `${createHash('sha1').update(upstream).digest('hex')}.json`)
          const age = (() => {
            try {
              return Date.now() - statSync(file).mtimeMs
            } catch {
              return Infinity
            }
          })()
          // Open-Meteo sometimes answers 200 with a plain-text error body
          // ("Unexpected error while streaming data: …"). Cached, that text
          // would be served as fresh JSON to every later session — the app's
          // resp.json() throws and the outlook strip loses its hour row. So
          // JSON-validate on both sides of the disk: never write garbage,
          // and never serve a poisoned file an older build already wrote.
          const readValid = (): Buffer | null => {
            try {
              const body = readFileSync(file)
              JSON.parse(body.toString('utf8'))
              return body
            } catch {
              return null
            }
          }
          const serve = (body: Buffer, tag: 'fresh' | 'stale' | 'miss') => {
            res.setHeader('content-type', 'application/json')
            res.setHeader('x-om-cache', tag)
            res.end(body)
          }
          if (age < FRESH_MS) {
            const body = readValid()
            if (body) {
              serve(body, 'fresh')
              return
            }
            // poisoned while "fresh" — fall through and refetch
          }
          try {
            const up = await fetch(upstream)
            if (!up.ok) throw new Error(`upstream ${up.status}`)
            const body = Buffer.from(await up.arrayBuffer())
            JSON.parse(body.toString('utf8')) // upstream 200 can still be an error string
            writeFileSync(file, body)
            serve(body, 'miss')
          } catch (e) {
            const body = age < Infinity ? readValid() : null
            if (body) {
              serve(body, 'stale') // stale beats down
              return
            }
            res.statusCode = 502
            res.end(String(e))
          }
        })()
      })
    },
  }
}

/**
 * Which build is this? Stamped into the bundle for the "Report a problem"
 * email (src/diagnostics.ts) — a report that names its commit is one you
 * can actually reproduce. CI has GITHUB_SHA; a local build asks git.
 */
function buildStamp(): { sha: string; at: string } {
  const sha =
    process.env.GITHUB_SHA ??
    (() => {
      try {
        return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim()
      } catch {
        return 'local'
      }
    })()
  return { sha: sha.slice(0, 7), at: new Date().toISOString() }
}

// BASE_PATH lets the same build target GitHub Pages project sites (e.g. /BoatApp/)
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // the family's phones are current; es2022 output skips the helpers older
  // targets need and parses faster on the phone at launch
  build: { target: ['es2022', 'safari16'] },
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  // allow phone/tunnel access to the local servers
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  plugins: [
    // HTTPS_DEV=1 serves over self-signed HTTPS so an iPhone on the same
    // Wi-Fi gets a secure context (required for geolocation)
    ...(process.env.HTTPS_DEV ? [basicSsl()] : []),
    omCache(),
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
        // the push handlers live in public/push-sw.js, beside the generated worker
        importScripts: ['push-sw.js'],
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
