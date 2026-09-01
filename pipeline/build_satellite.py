"""
Bake Sentinel-2 imagery into an offline PMTiles archive for a region.

Source is Copernicus Sentinel-2 L2A, read straight from the public cloud-
optimised GeoTIFFs on AWS (no account, no key). Scenes are picked by STAC for
one near-cloudless date over the whole region, so the mosaic is seam-free and
same-day; any corner the primary date misses is filled from other clear dates.

Why not a ready-made basemap: general-purpose imagery is stretched for land,
which blows the Sandies' shoals out to featureless white. Reading the raw
bands lets us stretch for water instead, so sandbars, ripples and the channels
between them stay legible — the whole reason this layer exists.

Full-region coverage at low zooms, then water-adjacent tiles only at high
zooms (using the depth grid's water mask, dilated to include the shoreline
strip) — sharp imagery where the boat goes without baking every inland
forest tile. The app overzooms the top level, so land beyond the shore
strip still renders, just softer.

Intermediates are cached in raw/sentinel so reruns are cheap (the reprojected
mosaic is a few hundred MB — raw/ is gitignored).

Licence: Copernicus Sentinel data are free to use and redistribute, including
commercially, with attribution. Credit "Contains modified Copernicus Sentinel
data <year>" wherever the layer is shown.

Output (into app/public/data):
  satellite-<region>.pmtiles   raster JPEG tiles

Usage: python build_satellite.py            # builds superior-east
       python build_satellite.py --scout    # list near-cloudless dates
"""

import io
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds, intersect, intersection

from build_region import REGION, lat_to_tile, lon_to_tile
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

STAC_URL = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"

# One date that is near-cloudless across every scene covering the region.
# To re-pick, run with --scout.
SCENE_DATE = "2023-08-30"
# Extra clear dates, tried in order, only to fill what the primary date misses.
GAP_FILL_DATES = ["2023-09-04", "2024-08-02"]
MAX_CLOUD = 8.0

# Water-tuned stretch. Sentinel-2 surface reflectance over Whitefish Bay runs
# ~120-700; a land-oriented ceiling (~3000) would crush all of that to black.
# One shared scale across the three bands keeps the colour natural.
STRETCH_MAX = 1400
STRETCH_GAMMA = 0.65

OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "public" / "data"
CACHE_DIR = Path(__file__).resolve().parent / "raw" / "sentinel"
DGRID = OUT_DIR / f"depthgrid-{REGION['name']}.dgrid"

# Below MIN_ZOOM the region fills too little of a tile to be worth baking, and
# the archive's min_zoom lets the basemap show through instead.
MIN_ZOOM = 10
FULL_MAX_ZOOM = 12  # whole bbox up to here (matches depth raster)
WATER_MAX_ZOOM = 14  # water + shoreline strip only above FULL_MAX_ZOOM
SHORE_DILATE_CELLS = 5  # ~90 m/cell → ~450 m strip of land kept around water
NODATA_I16 = 32767
JPEG_QUALITY = 82
STRIP_ROWS = 2048  # the mosaic is written in horizontal strips to bound memory

MERC_HALF = 20037508.342789244


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


# --------------------------------------------------------------- STAC search


def stac_search(bbox, start, end):
    """All matching scenes, following the API's paging (it caps a page at 100)."""
    body = {
        "collections": [COLLECTION],
        "bbox": list(bbox),
        "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
        "query": {"eo:cloud_cover": {"lt": MAX_CLOUD}},
        "limit": 100,
    }
    feats = []
    while True:
        req = urllib.request.Request(
            STAC_URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            page = json.load(resp)
        feats.extend(page["features"])
        nxt = next((l for l in page.get("links", []) if l.get("rel") == "next"), None)
        if not nxt or not page["features"]:
            return feats
        body = {**body, **nxt.get("body", {})}


def scout(bbox):
    """Print the dates where every scene over the region is near-cloudless."""
    feats = stac_search(bbox, "2022-05-01", "2026-10-31")
    by_date = {}
    for f in feats:
        p = f["properties"]
        by_date.setdefault(p["datetime"][:10], []).append(
            (p.get("grid:code"), round(p["eo:cloud_cover"], 2))
        )
    tiles = {t for v in by_date.values() for t, _ in v}
    print(f"{len(tiles)} scene footprints cover the region: {sorted(tiles)}\n")
    for date, v in sorted(by_date.items()):
        if len(v) >= len(tiles):
            print(f"  {date}  {len(v)} scenes, worst cloud {max(c for _, c in v)}%")


# ------------------------------------------------------------ scene fetching


def stretch(band):
    """Reflectance → 8-bit, shared scale so colour stays natural. 0 = nodata."""
    valid = band > 0
    out = np.clip(band / STRETCH_MAX, 0, 1) ** STRETCH_GAMMA * 255
    return np.where(valid, np.clip(out, 1, 255), 0).astype(np.uint8)


def extent_tag(ll_bounds):
    """Geographic extent baked into cache filenames: a cached intermediate is
    only valid for the exact bounds it was cut to. Without this, a REGION bbox
    change silently reused the old mosaic and every tile rendered displaced
    imagery (land where Whitefish Bay belongs — 2026-09-01)."""
    w, s, e, n = ll_bounds
    return f"w{-w:.2f}s{s:.2f}e{-e:.2f}n{n:.2f}"


def fetch_scene(feature, ll_bounds):
    """Window-read R/G/B over the region, stretch, cache as a local UTM GeoTIFF."""
    sid = feature["id"]
    dst = CACHE_DIR / f"{sid}-{extent_tag(ll_bounds)}.tif"
    if dst.exists():
        return dst
    assets = feature["assets"]
    bands, profile = [], None
    for key in ("red", "green", "blue"):
        with rasterio.open("/vsicurl/" + assets[key]["href"]) as ds:
            utm = transform_bounds("EPSG:4326", ds.crs, *ll_bounds, densify_pts=21)
            want = from_bounds(*utm, transform=ds.transform).round_offsets().round_lengths()
            full = Window(0, 0, ds.width, ds.height)
            if not intersect([want, full]):
                return None
            win = intersection(want, full)
            if win.width < 1 or win.height < 1:
                return None
            bands.append(stretch(ds.read(1, window=win).astype(np.float32)))
            if profile is None:
                profile = {
                    "crs": ds.crs,
                    "transform": ds.window_transform(win),
                    "width": int(win.width),
                    "height": int(win.height),
                }
    dst.parent.mkdir(parents=True, exist_ok=True)
    # temp-then-rename: a run killed mid-write must never leave a file the
    # next run's exists() check will trust (torn-mosaic incident, 2026-09-01)
    tmp = dst.with_name(dst.name + ".part")
    with rasterio.open(
        tmp, "w", driver="GTiff", count=3, dtype="uint8", nodata=0,
        tiled=True, blockxsize=512, blockysize=512, compress="deflate", **profile
    ) as out:
        for i, b in enumerate(bands, 1):
            out.write(b, i)
    tmp.replace(dst)
    print(f"    cached {sid} ({profile['width']}x{profile['height']})")
    return dst


# -------------------------------------------------------------------- mosaic


def mosaic_grid(region):
    """Web-mercator grid aligned to the MIN_ZOOM tile lattice, at max-zoom res.

    Aligning to the coarsest baked zoom means every tile at every zoom lands on
    an exact pixel window of the mosaic — no resampling drift between levels.
    """
    x0 = lon_to_tile(region["west"], MIN_ZOOM)
    x1 = lon_to_tile(region["east"] - 1e-9, MIN_ZOOM)
    y0 = lat_to_tile(region["north"], MIN_ZOOM)
    y1 = lat_to_tile(region["south"] + 1e-9, MIN_ZOOM)
    scale = 2 ** (WATER_MAX_ZOOM - MIN_ZOOM)
    res = 2 * MERC_HALF / (2**WATER_MAX_ZOOM * 256)
    west = -MERC_HALF + x0 * scale * 256 * res
    north = MERC_HALF - y0 * scale * 256 * res
    return {
        "x0": x0,
        "y0": y0,
        "width": (x1 - x0 + 1) * scale * 256,
        "height": (y1 - y0 + 1) * scale * 256,
        "res": res,
        "west": west,
        "north": north,
        "transform": from_origin(west, north, res, res),
        "ll_bounds": (
            tile_bounds(MIN_ZOOM, x0, y1)[0],
            tile_bounds(MIN_ZOOM, x0, y1)[1],
            tile_bounds(MIN_ZOOM, x1, y0)[2],
            tile_bounds(MIN_ZOOM, x1, y0)[3],
        ),
    }


def build_mosaic(region, grid, scene_paths):
    """Reproject the cached scenes into one web-mercator RGB mosaic."""
    out = CACHE_DIR / f"mosaic-{region['name']}-{SCENE_DATE}-{extent_tag(grid['ll_bounds'])}.tif"
    if out.exists():
        print(f"  mosaic cached ({out.stat().st_size / 1e6:.0f} MB)")
        return out
    tmp = out.with_name(out.name + ".part")  # rename on success only
    srcs = [rasterio.open(p) for p in scene_paths]
    # dest-row span of each source, so a strip skips sources it cannot touch
    spans = []
    for s in srcs:
        b = transform_bounds(s.crs, "EPSG:3857", *s.bounds, densify_pts=21)
        spans.append((
            int((grid["north"] - b[3]) / grid["res"]) - 1,
            int((grid["north"] - b[1]) / grid["res"]) + 1,
        ))
    strips = math.ceil(grid["height"] / STRIP_ROWS)
    try:
        with rasterio.open(
            tmp, "w", driver="GTiff", width=grid["width"], height=grid["height"],
            count=3, dtype="uint8", nodata=0, crs="EPSG:3857",
            transform=grid["transform"], tiled=True, blockxsize=512, blockysize=512,
            compress="deflate", photometric="rgb", BIGTIFF="IF_SAFER",
        ) as dst:
            for row0 in range(0, grid["height"], STRIP_ROWS):
                h = min(STRIP_ROWS, grid["height"] - row0)
                buf = np.zeros((3, h, grid["width"]), np.uint8)
                strip_t = from_origin(
                    grid["west"], grid["north"] - row0 * grid["res"], grid["res"], grid["res"]
                )
                for src, (r0, r1) in zip(srcs, spans):
                    if r1 < row0 or r0 > row0 + h:
                        continue
                    reproject(
                        source=rasterio.band(src, src.indexes),
                        destination=buf,
                        dst_transform=strip_t,
                        dst_crs="EPSG:3857",
                        src_nodata=0,
                        dst_nodata=0,
                        resampling=Resampling.bilinear,
                        init_dest_nodata=False,  # earlier sources keep their pixels
                        num_threads=4,
                    )
                dst.write(buf, window=Window(0, row0, grid["width"], h))
                print(f"    strip {row0 // STRIP_ROWS + 1}/{strips}", end="\r")
    finally:
        for s in srcs:
            s.close()
    tmp.replace(out)
    print(f"  wrote mosaic ({out.stat().st_size / 1e6:.0f} MB)          ")
    return out


def cut_tile(ms, grid, z, x, y):
    """Read one 256 px tile straight out of the mosaic and JPEG-encode it."""
    scale = 2 ** (WATER_MAX_ZOOM - z)
    origin = 2 ** (WATER_MAX_ZOOM - MIN_ZOOM)
    win = Window(
        (x * scale - grid["x0"] * origin) * 256,
        (y * scale - grid["y0"] * origin) * 256,
        256 * scale,
        256 * scale,
    )
    arr = ms.read(
        window=win, out_shape=(3, 256, 256), boundless=True, fill_value=0,
        resampling=Resampling.average if scale > 1 else Resampling.bilinear,
    )
    buf = io.BytesIO()
    Image.fromarray(np.moveaxis(arr, 0, -1)).save(
        buf, format="JPEG", quality=JPEG_QUALITY, optimize=True
    )
    return buf.getvalue()


def collect_scenes(grid):
    """Cached scene rasters, gap-fill dates first so the primary date wins."""
    paths = []
    for date in reversed(GAP_FILL_DATES):
        for f in stac_search(grid["ll_bounds"], date, date):
            p = fetch_scene(f, grid["ll_bounds"])
            if p:
                paths.append(p)
    primary = stac_search(grid["ll_bounds"], SCENE_DATE, SCENE_DATE)
    if not primary:
        return None
    print(f"  {SCENE_DATE}: {len(primary)} scenes, worst cloud "
          f"{max(f['properties']['eo:cloud_cover'] for f in primary):.2f}%")
    for f in primary:
        p = fetch_scene(f, grid["ll_bounds"])
        if p:
            paths.append(p)
    return paths


def main():
    region = REGION
    bbox = (region["west"], region["south"], region["east"], region["north"])
    if "--scout" in sys.argv:
        scout(bbox)
        return 0

    grid = mosaic_grid(region)
    print(f"mosaic grid: {grid['width']}x{grid['height']} px @ z{WATER_MAX_ZOOM}, "
          f"aligned to the z{MIN_ZOOM} lattice")

    print("finding scenes…")
    scene_paths = collect_scenes(grid)
    if not scene_paths:
        print(f"no scenes under {MAX_CLOUD}% cloud on {SCENE_DATE} — "
              f"run with --scout to pick another date")
        return 1

    print("building mosaic…")
    mosaic = build_mosaic(region, grid, scene_paths)

    mask, hdr = load_water_mask()
    mask = dilate(mask, SHORE_DILATE_CELLS)
    print(f"water+shore mask: {mask.mean():.1%} of region")

    # enumerate tiles: full bbox to FULL_MAX_ZOOM, water-adjacent only above
    wanted = []  # (tileid, z, x, y), per-zoom sorted → globally tileid-ascending
    for z in range(MIN_ZOOM, WATER_MAX_ZOOM + 1):
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

    print(f"cutting {len(wanted)} tiles…")
    out = OUT_DIR / f"satellite-{region['name']}.pmtiles"
    with rasterio.open(mosaic) as ms, open(out, "wb") as f:
        writer = Writer(f)
        for i, (tileid, z, x, y) in enumerate(wanted):
            writer.write_tile(tileid, cut_tile(ms, grid, z, x, y))
            if i % 200 == 0:
                print(f"    {i}/{len(wanted)}", end="\r")
        writer.finalize(
            {
                "tile_type": TileType.JPEG,
                "tile_compression": Compression.NONE,
                "min_zoom": MIN_ZOOM,
                "max_zoom": WATER_MAX_ZOOM,
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
                "attribution": f"Contains modified Copernicus Sentinel data {SCENE_DATE[:4]}",
            },
        )
    print(f"wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB, {len(wanted)} tiles)   ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
