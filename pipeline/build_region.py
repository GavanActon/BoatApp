"""
Build all chart data for a region from NOAA NCEI's DEM_global_mosaic ImageServer
(the same service behind NCEI's Grid Extract tool — includes the Great Lakes
3 arc-second bathymetry, values in metres relative to low water datum,
negative = below water).

Outputs (into app/public/data):
  depth-<region>.pmtiles      raster tiles z6–z12, hillshaded depth ramp, PNG
  contours-<region>.json      GeoJSON: contour lines (kind=contour) + spot
                              soundings (kind=sounding), depths in metres
  depthgrid-<region>.dgrid    binary grid for instant depth lookups in the app

Usage: python build_region.py            # builds superior-east
"""

import io
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from contourpy import contour_generator
from shapely.geometry import LineString
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

# ----------------------------------------------------------------------------
# region definition
# ----------------------------------------------------------------------------

REGION = {
    "name": "superior-east",
    "west": -85.3,
    "south": 46.3,
    "east": -83.9,
    "north": 47.25,
    "arcsec": 3,  # source resolution to request
    "tile_min_zoom": 6,
    "tile_max_zoom": 12,
}

OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "public" / "data"
CACHE_DIR = Path(__file__).resolve().parent / "raw"

EXPORT_URL = (
    "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/"
    "ImageServer/exportImage"
)

NODATA_I16 = 32767
LAND_THRESHOLD = -0.1  # elevation >= this → treated as land

CONTOUR_LEVELS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 150, 200, 250, 300]

# depth (m) → RGB ramp, light shallows → deep navy
RAMP = [
    (0.0, (191, 233, 242)),
    (2.0, (154, 219, 232)),
    (5.0, (111, 195, 221)),
    (10.0, (74, 163, 201)),
    (20.0, (50, 130, 180)),
    (40.0, (33, 97, 143)),
    (70.0, (22, 70, 107)),
    (120.0, (13, 48, 80)),
    (250.0, (8, 31, 56)),
]

MAX_REQ_PX = 4000  # ImageServer export size limit safety margin


# ----------------------------------------------------------------------------
# DEM fetch (tiled requests, cached to disk)
# ----------------------------------------------------------------------------


def fetch_dem(west, south, east, north, arcsec):
    """Return (elev float32 array row0=north, lons centers, lats centers desc)."""
    px_per_deg = 3600 // arcsec
    width = round((east - west) * px_per_deg)
    height = round((north - south) * px_per_deg)

    cache = CACHE_DIR / f"dem_{west}_{south}_{east}_{north}_{arcsec}.npy"
    if cache.exists():
        elev = np.load(cache)
        print(f"loaded cached DEM {elev.shape}")
    else:
        elev = np.empty((height, width), dtype=np.float32)
        n_x = math.ceil(width / MAX_REQ_PX)
        n_y = math.ceil(height / MAX_REQ_PX)
        for iy in range(n_y):
            for ix in range(n_x):
                x0 = ix * MAX_REQ_PX
                y0 = iy * MAX_REQ_PX
                w_px = min(MAX_REQ_PX, width - x0)
                h_px = min(MAX_REQ_PX, height - y0)
                bbox = (
                    west + x0 / px_per_deg,
                    north - (y0 + h_px) / px_per_deg,
                    west + (x0 + w_px) / px_per_deg,
                    north - y0 / px_per_deg,
                )
                url = (
                    f"{EXPORT_URL}?bbox={bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}"
                    f"&bboxSR=4326&size={w_px},{h_px}&imageSR=4326&format=tiff"
                    f"&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image"
                )
                print(f"fetching DEM chunk {ix},{iy} ({w_px}x{h_px})…")
                for attempt in range(4):
                    try:
                        with urllib.request.urlopen(url, timeout=180) as resp:
                            data = resp.read()
                        import tifffile

                        chunk = tifffile.imread(io.BytesIO(data))
                        break
                    except Exception as e:  # noqa: BLE001
                        if attempt == 3:
                            raise
                        print(f"  retry ({e})")
                        time.sleep(3 * (attempt + 1))
                elev[y0 : y0 + h_px, x0 : x0 + w_px] = chunk
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        np.save(cache, elev)
        print(f"fetched DEM {elev.shape}")

    lons = west + (np.arange(width) + 0.5) / px_per_deg
    lats = north - (np.arange(height) + 0.5) / px_per_deg  # descending
    return elev, lons, lats


# ----------------------------------------------------------------------------
# outputs
# ----------------------------------------------------------------------------


def write_dgrid(path, depth, region):
    """depth: metres positive down, NaN=land, row0=north."""
    header = json.dumps(
        {
            "west": region["west"],
            "south": region["south"],
            "east": region["east"],
            "north": region["north"],
            "nx": depth.shape[1],
            "ny": depth.shape[0],
        }
    ).encode()
    dm = np.where(np.isnan(depth), NODATA_I16, np.clip(np.round(depth * 10), -32000, 32000))
    dm = dm.astype("<i2")
    with open(path, "wb") as f:
        f.write(len(header).to_bytes(4, "little"))
        f.write(header)
        f.write(dm.tobytes())
    print(f"wrote {path.name} ({path.stat().st_size / 1e6:.1f} MB)")


def build_ramp_lut():
    """LUT for depth 0..400 m in 0.1 m steps → RGB."""
    depths = np.array([d for d, _ in RAMP])
    chans = np.array([c for _, c in RAMP], dtype=float)
    q = np.arange(0, 400.01, 0.1)
    lut = np.stack([np.interp(q, depths, chans[:, i]) for i in range(3)], axis=1)
    return lut  # (4001, 3)


def hillshade(elev_like, lat_mid, cell_deg, az_deg=315.0, alt_deg=45.0):
    """Lambertian hillshade of the (negated-depth) surface, NaN-safe → 0..1."""
    z = np.where(np.isnan(elev_like), np.nanmean(elev_like), elev_like)
    dy_m = cell_deg * 110540.0
    dx_m = cell_deg * 111320.0 * math.cos(math.radians(lat_mid))
    gy, gx = np.gradient(z, dy_m, dx_m)
    gy = -gy  # row axis points south
    slope = np.arctan(np.hypot(gx, gy) * 3.0)  # ×3 vertical exaggeration
    aspect = np.arctan2(-gx, gy)
    az = math.radians(az_deg)
    alt = math.radians(alt_deg)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip((shade + 1) / 2, 0, 1)


def bilinear(grid, lons, lats_desc, qlon, qlat):
    """Sample grid (row0=north) at query lon/lat mesh. Returns NaN outside."""
    west, east = lons[0], lons[-1]
    north, south = lats_desc[0], lats_desc[-1]
    nx = len(lons)
    ny = len(lats_desc)
    fx = (qlon - west) / (east - west) * (nx - 1)
    fy = (north - qlat) / (north - south) * (ny - 1)
    valid = (fx >= 0) & (fx <= nx - 1) & (fy >= 0) & (fy <= ny - 1)
    fx = np.clip(fx, 0, nx - 1.001)
    fy = np.clip(fy, 0, ny - 1.001)
    x0 = fx.astype(int)
    y0 = fy.astype(int)
    dx = fx - x0
    dy = fy - y0
    v00 = grid[y0, x0]
    v10 = grid[y0, x0 + 1]
    v01 = grid[y0 + 1, x0]
    v11 = grid[y0 + 1, x0 + 1]
    out = v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy
    out = np.where(valid, out, np.nan)
    return out


def tile_lonlat_mesh(z, x, y, size=256):
    """Pixel-center lon/lat arrays for a web mercator tile."""
    n = 2**z
    xs = (x + (np.arange(size) + 0.5) / size) / n * 360.0 - 180.0
    yn = (y + (np.arange(size) + 0.5) / size) / n
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * yn))))
    return np.meshgrid(xs, lat)


def lon_to_tile(lon, z):
    return int((lon + 180) / 360 * 2**z)


def lat_to_tile(lat, z):
    r = math.radians(lat)
    return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * 2**z)


def fill_nearest(depth, iterations=8):
    """Fill NaN cells with the mean of valid 3x3 neighbours, repeated.
    Gives sensible depth values just past the shoreline so edge feathering
    has something to sample."""
    z = depth.copy()
    for _ in range(iterations):
        nan = np.isnan(z)
        if not nan.any():
            break
        zf = np.nan_to_num(z, nan=0.0)
        valid = (~nan).astype(np.float32)
        ksum = np.zeros_like(zf)
        kcnt = np.zeros_like(valid)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ksum += np.roll(np.roll(zf, dy, 0), dx, 1)
                kcnt += np.roll(np.roll(valid, dy, 0), dx, 1)
        with np.errstate(invalid="ignore", divide="ignore"):
            filled = ksum / kcnt
        z = np.where(nan & (kcnt > 0), filled, z)
    return z


def write_depth_pmtiles(path, depth, shade, lons, lats, region):
    lut = build_ramp_lut()
    wmask = (~np.isnan(depth)).astype(np.float32)
    depth_filled = fill_nearest(depth)
    minz, maxz = region["tile_min_zoom"], region["tile_max_zoom"]
    count = 0
    with open(path, "wb") as f:
        writer = Writer(f)
        for z in range(minz, maxz + 1):
            x0 = lon_to_tile(region["west"], z)
            x1 = lon_to_tile(region["east"] - 1e-9, z)
            y0 = lat_to_tile(region["north"], z)
            y1 = lat_to_tile(region["south"] + 1e-9, z)
            tiles = sorted(
                ((zxy_to_tileid(z, x, y), x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1))
            )
            for tileid, x, y in tiles:
                qlon, qlat = tile_lonlat_mesh(z, x, y)
                w = bilinear(wmask, lons, lats, qlon, qlat)
                w = np.nan_to_num(w, nan=0.0)
                if w.max() <= 0.02:
                    continue
                d = bilinear(depth_filled, lons, lats, qlon, qlat)
                d = np.nan_to_num(d, nan=0.0)
                s = bilinear(shade, lons, lats, qlon, qlat)
                s = np.where(np.isnan(s), 0.5, s)
                idx = np.clip((d * 10).astype(int), 0, 4000)
                rgb = lut[idx]  # (256,256,3)
                tone = (0.72 + 0.28 * s)[..., None]
                rgb = np.clip(rgb * tone, 0, 255).astype(np.uint8)
                # feathered shoreline: fractional water mask drives alpha
                alpha = (np.clip(w, 0, 1) ** 0.8 * 235).astype(np.uint8)
                img = np.dstack([rgb, alpha])
                buf = io.BytesIO()
                Image.fromarray(img, "RGBA").save(buf, format="PNG", optimize=True)
                writer.write_tile(tileid, buf.getvalue())
                count += 1
            print(f"z{z}: done ({count} tiles total)")
        writer.finalize(
            {
                "tile_type": TileType.PNG,
                "tile_compression": Compression.NONE,
                "min_lon_e7": int(region["west"] * 1e7),
                "min_lat_e7": int(region["south"] * 1e7),
                "max_lon_e7": int(region["east"] * 1e7),
                "max_lat_e7": int(region["north"] * 1e7),
                "center_zoom": 10,
                "center_lon_e7": int((region["west"] + region["east"]) / 2 * 1e7),
                "center_lat_e7": int((region["south"] + region["north"]) / 2 * 1e7),
            },
            {"name": f"depth-{region['name']}", "attribution": "NOAA NCEI Great Lakes Bathymetry"},
        )
    print(f"wrote {path.name} ({path.stat().st_size / 1e6:.1f} MB, {count} tiles)")


def build_contours(depth, lons, lats_desc):
    """GeoJSON features for contour lines. Depths metres."""
    # contourpy wants ascending y; flip rows
    z = np.flipud(depth)
    lats_asc = lats_desc[::-1]
    masked = np.ma.masked_invalid(z)
    gen = contour_generator(x=lons, y=lats_asc, z=masked, name="serial")
    features = []
    for level in CONTOUR_LEVELS:
        for seg in gen.lines(level):
            if len(seg) < 4:
                continue
            line = LineString(seg).simplify(0.00025, preserve_topology=False)
            if line.length < 0.004:
                continue
            coords = [[round(c[0], 5), round(c[1], 5)] for c in line.coords]
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {"kind": "contour", "depth": level},
                }
            )
    print(f"contours: {len(features)} lines")
    return features


def build_soundings(depth, lons, lats_desc, block=15):
    """Spot soundings: shoalest point per block (mariner-conservative)."""
    ny, nx = depth.shape
    features = []
    for by in range(0, ny - block, block):
        for bx in range(0, nx - block, block):
            blk = depth[by : by + block, bx : bx + block]
            if np.all(np.isnan(blk)):
                continue
            # skip blocks touching shore: labels crowd the coastline otherwise
            if np.isnan(blk).mean() > 0.3:
                continue
            iy, ix = np.unravel_index(np.nanargmin(blk), blk.shape)
            d = float(blk[iy, ix])
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [
                            round(float(lons[bx + ix]), 5),
                            round(float(lats_desc[by + iy]), 5),
                        ],
                    },
                    "properties": {"kind": "sounding", "depth": round(d, 1)},
                }
            )
    print(f"soundings: {len(features)} points")
    return features


def main():
    region = REGION
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    elev, lons, lats = fetch_dem(
        region["west"], region["south"], region["east"], region["north"], region["arcsec"]
    )
    depth = np.where(elev < LAND_THRESHOLD, -elev, np.nan).astype(np.float32)
    water_frac = float(np.mean(~np.isnan(depth)))
    print(f"water fraction: {water_frac:.2%}, max depth {np.nanmax(depth):.0f} m")

    write_dgrid(OUT_DIR / f"depthgrid-{region['name']}.dgrid", depth, region)

    cell_deg = region["arcsec"] / 3600.0
    lat_mid = (region["south"] + region["north"]) / 2
    shade = hillshade(-np.nan_to_num(depth, nan=0.0), lat_mid, cell_deg).astype(np.float32)

    write_depth_pmtiles(
        OUT_DIR / f"depth-{region['name']}.pmtiles", depth, shade, lons, lats, region
    )

    features = build_contours(depth, lons, lats) + build_soundings(depth, lons, lats)
    contours_path = OUT_DIR / f"contours-{region['name']}.json"
    with open(contours_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    print(f"wrote {contours_path.name} ({contours_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
