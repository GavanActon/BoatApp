# Sandies — Lake Superior Chartplotter PWA

Offline-first boating app for Whitefish Bay / the Sandy Islands (eastern Lake
Superior): depth charts with contours and soundings, GPS tracking with a
chartplotter-style instrument bar, and wind & wave forecasts as a map layer.
Installs to an iPhone home screen from Safari — no App Store.

## Layout

- `app/` — the PWA (Vite + React + TypeScript, MapLibre GL, PMTiles)
- `pipeline/` — Python scripts that generate chart data into `app/public/data/`
  - `build_region.py` — NOAA NCEI bathymetry → depth-shaded tiles (PMTiles),
    contour/sounding GeoJSON, and a binary depth grid for instant lookups
  - `gen_icons.py` — app icons

## Develop

```
cd app
npm install
npm run dev
```

## Regenerate chart data (or add a new region)

Edit `REGION` in `pipeline/build_region.py` (any Great Lakes bbox works — data
comes from NOAA's DEM_global_mosaic service), then:

```
python pipeline/build_region.py
```

Basemap extract for a new region (OpenStreetMap via Protomaps):

```
pipeline/tools/pmtiles.exe extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  app/public/data/basemap-<region>.pmtiles --bbox=W,S,E,N --maxzoom=14
```

## Deploy

Pushing to `main` on GitHub builds and deploys via GitHub Pages
(`.github/workflows/deploy.yml`). In the repo settings, set
**Pages → Source → GitHub Actions** (one-time).

Data sources: NOAA NCEI Great Lakes Bathymetry · OpenStreetMap/Protomaps ·
OpenSeaMap · Open-Meteo. Not for navigation — always carry official charts.
