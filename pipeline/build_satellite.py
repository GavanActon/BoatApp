"""
Bake Esri World Imagery into an offline PMTiles archive for a region.

Full-region coverage at low zooms, then water-adjacent tiles only at high
zooms (using the depth grid's water mask, dilated to include the shoreline
strip) — sharp imagery where the boat goes without baking every inland
forest tile. The app overzooms the top level, so land beyond the shore
strip still renders, just softer.

Source tiles are cached in raw/satellite so reruns only fetch what's new.

Output (into app/public/data):
  satellite-<region>.pmtiles   raster JPEG tiles

Usage: python build_satellite.py           # builds superior-east
"""

import io
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from build_region import REGION, lat_to_tile, lon_to_tile
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

TILE_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/"
    "MapServer/tile/{z}/{y}/{x}"
)

OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "public" / "data"
CACHE_DIR = Path(__file__).resolve().parent / "raw" / "satellite"
DGRID = OUT_DIR / f"depthgrid-{REGION['name']}.dgrid"

FULL_MAX_ZOOM = 12  # whole bbox up to here (matches depth raster)
WATER_MAX_ZOOM = 14  # water + shoreline strip only above FULL_MAX_ZOOM
SHORE_DILATE_CELLS = 5  # ~90 m/cell → ~450 m strip of land kept around water
NODATA_I16 = 32767
FETCH_WORKERS = 10


def load_water_mask():
    """Water mask (row0=north) + bbox from the depth grid built by build_region."""
    with open(DGRID, "rb") as f:
        hlen = int.from_bytes(f.read(4), "little")
        hdr = json.loads(f.read(hlen))
        grid = np.frombuffer(f.read(), dtype="<i2").reshape(hdr["ny"], hdr["nx"])
    return grid != NODATA_I16, hdr


def dilate(mask, iterations):
    m = mask.copy()
    for _ in range(iterations):
        grown = m.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                grown |= np.roll(np.roll(m, dy, 0), dx, 1)
        m = grown
    return m


def tile_bounds(z, x, y):
    """(west, south, east, north) of a web mercator tile."""
    n = 2**z
    import math

    def lat(yn):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yn))))

    return (x / n * 360 - 180, lat((y + 1) / n), (x + 1) / n * 360 - 180, lat(y / n))


def touches_water(mask, hdr, z, x, y):
    w, s, e, n = tile_bounds(z, x, y)
    nx, ny = hdr["nx"], hdr["ny"]
    x0 = int((w - hdr["west"]) / (hdr["east"] - hdr["west"]) * nx)
    x1 = int((e - hdr["west"]) / (hdr["east"] - hdr["west"]) * nx) + 1
    y0 = int((hdr["north"] - n) / (hdr["north"] - hdr["south"]) * ny)
    y1 = int((hdr["north"] - s) / (hdr["north"] - hdr["south"]) * ny) + 1
    x0, x1 = max(x0, 0), min(x1, nx)
    y0, y1 = max(y0, 0), min(y1, ny)
    if x0 >= x1 or y0 >= y1:
        return False
    return bool(mask[y0:y1, x0:x1].any())


def fetch_tile(z, x, y):
    """Return JPEG bytes, from cache or the tile service (with retries)."""
    cached = CACHE_DIR / str(z) / str(x) / f"{y}.jpg"
    if cached.exists():
        return cached.read_bytes()
    url = TILE_URL.format(z=z, x=x, y=y)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sandies-chartplotter-bake"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            if not data.startswith(b"\xff\xd8"):
                raise ValueError(f"not a JPEG ({len(data)} bytes)")
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(data)
            return data
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    return None  # unreachable


def main():
    region = REGION
    mask, hdr = load_water_mask()
    mask = dilate(mask, SHORE_DILATE_CELLS)
    print(f"water+shore mask: {mask.mean():.1%} of region")

    # enumerate tiles: full bbox to FULL_MAX_ZOOM, water-adjacent only above
    wanted = []  # (tileid, z, x, y), per-zoom sorted → globally tileid-ascending
    for z in range(6, WATER_MAX_ZOOM + 1):
        x0 = lon_to_tile(region["west"], z)
        x1 = lon_to_tile(region["east"] - 1e-9, z)
        y0 = lat_to_tile(region["north"], z)
        y1 = lat_to_tile(region["south"] + 1e-9, z)
        zoom_tiles = [
            (zxy_to_tileid(z, x, y), z, x, y)
            for x in range(x0, x1 + 1)
            for y in range(y0, y1 + 1)
            if z <= FULL_MAX_ZOOM or touches_water(mask, hdr, z, x, y)
        ]
        skipped = (x1 - x0 + 1) * (y1 - y0 + 1) - len(zoom_tiles)
        print(f"z{z}: {len(zoom_tiles)} tiles" + (f" ({skipped} inland skipped)" if skipped else ""))
        wanted.extend(sorted(zoom_tiles))

    print(f"fetching {len(wanted)} tiles…")
    with ThreadPoolExecutor(FETCH_WORKERS) as pool:
        blobs = list(pool.map(lambda t: fetch_tile(t[1], t[2], t[3]), wanted))

    out = OUT_DIR / f"satellite-{region['name']}.pmtiles"
    with open(out, "wb") as f:
        writer = Writer(f)
        for (tileid, _z, _x, _y), data in zip(wanted, blobs):
            writer.write_tile(tileid, data)
        writer.finalize(
            {
                "tile_type": TileType.JPEG,
                "tile_compression": Compression.NONE,
                "min_lon_e7": int(region["west"] * 1e7),
                "min_lat_e7": int(region["south"] * 1e7),
                "max_lon_e7": int(region["east"] * 1e7),
                "max_lat_e7": int(region["north"] * 1e7),
                "center_zoom": 10,
                "center_lon_e7": int((region["west"] + region["east"]) / 2 * 1e7),
                "center_lat_e7": int((region["south"] + region["north"]) / 2 * 1e7),
            },
            {
                "name": f"satellite-{region['name']}",
                "attribution": "Imagery © Esri, Maxar, Earthstar Geographics",
            },
        )
    print(f"wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB, {len(wanted)} tiles)")


if __name__ == "__main__":
    sys.exit(main())
