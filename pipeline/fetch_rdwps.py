"""Fetch ECCC RDWPS Lake Superior wave forecasts into the app's data folder.

The app's wave numbers come from Open-Meteo's global marine models (~8-25 km),
which barely resolve Whitefish Bay. ECCC's Regional Deterministic Wave
Prediction System has a dedicated Lake Superior domain at ~1 km, forced by
HRDPS winds and ice-aware — the most accurate operational wave model for this
water. It publishes free GRIB2 on the MSC Datamart, hourly to +48 h, four
runs a day.

This script grabs the latest complete run, decodes three fields (significant
height HTSGW, mean zero-crossing period MZWPER, peak direction PWAVEDIR),
samples them at the app's own 8x7 forecast lattice (mirroring gridPoints() in
app/src/weather/openMeteo.ts EXACTLY — the app overlays these cells onto its
Open-Meteo grid by index), and writes a compact JSON the app fetches like any
other static file.

GRIB2 decoding is done here directly: the files are regular lat-lon grids,
JPEG2000-packed (template 5.40) with a bitmap over the lake. numpy +
imagecodecs is the whole dependency story — eccodes wheels are unreliable on
Windows, and Pillow silently right-shifts >16-bit JPEG2000 (verified: 4 bits
lost), so imagecodecs it is.

Usage: python fetch_rdwps.py [out.json]
Exit 0 with a written file, exit 1 (and no file touched) on any failure —
CI treats a failure as "keep yesterday's file", never as "break the deploy".
"""

from __future__ import annotations

import json
import math
import struct
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from imagecodecs import jpeg2k_decode

BASE = "https://dd.weather.gc.ca"
DOMAIN = "superior"
RES = "1km"
GRID_TAG = "LatLon0.009x0.012"
HOURS = 48  # RDWPS horizon

# app/src/config.ts REGION_BBOX + openMeteo.ts GRID_SHAPE — keep in lockstep
REGION = {"west": -85.3, "south": 46.3, "east": -83.9, "north": 47.25}
COLS, ROWS = 8, 7

VARS = {
    "HTSGW": "waveM",  # significant wave height, m
    # peak period, not MZWPER: the dominant sea's period is what the app's
    # wavelength/steepness math wants, and it sits closest in kind to the
    # Open-Meteo number it stands beside past the 48 h seam
    "PWPER": "wavePeriodS",
    "PWAVEDIR": "waveDir",  # peak wave direction, deg (from)
}


def fetch(url: str) -> bytes | None:
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.read()
    except urllib.error.URLError:
        return None


def latest_run() -> tuple[str, str] | None:
    """(YYYYMMDD, HH) of the newest run whose final hour exists."""
    now = datetime.now(timezone.utc)
    for day_back in (0, 1):
        d = (now - timedelta(days=day_back)).strftime("%Y%m%d")
        for hh in ("18", "12", "06", "00"):
            run_dt = datetime.strptime(d + hh, "%Y%m%d%H").replace(tzinfo=timezone.utc)
            if run_dt > now:
                continue
            url = grib_url(d, hh, "HTSGW", HOURS)
            req = urllib.request.Request(url, method="HEAD")
            try:
                with urllib.request.urlopen(req, timeout=30):
                    return d, hh
            except urllib.error.URLError:
                continue
    return None


def grib_url(day: str, hh: str, var: str, fh: int) -> str:
    name = f"{day}T{hh}Z_MSC_RDWPS-Lake-Superior_{var}_Sfc_{GRID_TAG}_PT{fh:03d}H.grib2"
    return f"{BASE}/{day}/WXO-DD/model_rdwps/{DOMAIN}/{RES}/{hh}/{name}"


def s32(b: bytes) -> int:
    """GRIB sign-magnitude int32."""
    v = struct.unpack(">I", b)[0]
    return -(v & 0x7FFFFFFF) if v & 0x80000000 else v


def s16(b: bytes) -> int:
    """GRIB sign-magnitude int16 — NOT two's complement. The binary scale E
    is routinely -1 (0x8001); a '>h' read turns that into -32767 and every
    value collapses to the reference. Found the hard way."""
    v = struct.unpack(">H", b)[0]
    return -(v & 0x7FFF) if v & 0x8000 else v


def decode(grib: bytes) -> np.ndarray:
    """One RDWPS message -> (nj, ni) float array, NaN where the bitmap says no
    data (land). Regular lat-lon, +i east, +j north, JPEG2000 packing."""
    sec: dict[int, bytes] = {}
    i = 16
    while i < len(grib) - 4:
        if grib[i : i + 4] == b"7777":
            break
        sl, sn = struct.unpack(">IB", grib[i : i + 5])
        sec[sn] = grib[i : i + sl]
        i += sl

    g = sec[3]
    tmpl = struct.unpack(">H", g[12:14])[0]
    if tmpl != 0:
        raise ValueError(f"unexpected grid template {tmpl}")
    ni, nj = struct.unpack(">II", g[30:38])
    la1 = s32(g[46:50]) / 1e6
    lo1 = s32(g[50:54]) / 1e6
    di = struct.unpack(">I", g[63:67])[0] / 1e6
    dj = struct.unpack(">I", g[67:71])[0] / 1e6
    scan = g[71]
    if scan != 0x40:
        raise ValueError(f"unexpected scan mode {scan:#x}")

    p = sec[5]
    npts, ptmpl = struct.unpack(">IH", p[5:11])
    if ptmpl != 40:
        raise ValueError(f"unexpected packing template {ptmpl}")
    ref = struct.unpack(">f", p[11:15])[0]
    E = s16(p[15:17])
    D = s16(p[17:19])

    raw = jpeg2k_decode(sec[7][5:]).astype("f8").ravel()
    if raw.size != npts:
        raise ValueError(f"decoded {raw.size} points, expected {npts}")
    vals = (ref + raw * 2.0**E) / 10.0**D

    grid = np.full(ni * nj, np.nan)
    if sec[6][5] == 0:  # bitmap applies
        bits = np.unpackbits(np.frombuffer(sec[6][6:], dtype=np.uint8))[: ni * nj]
        grid[bits == 1] = vals
    else:
        grid[:] = vals
    grid = grid.reshape(nj, ni)  # row 0 = la1 (south), +j north

    # stash geometry on the array for the sampler
    return grid, (la1, lo1, di, dj)


def lattice() -> list[tuple[float, float]]:
    """The app's 8x7 forecast lattice, row-major — MUST mirror gridPoints()."""
    pts = []
    for r in range(ROWS):
        for c in range(COLS):
            lat = REGION["south"] + ((r + 0.5) / ROWS) * (REGION["north"] - REGION["south"])
            lon = REGION["west"] + ((c + 0.5) / COLS) * (REGION["east"] - REGION["west"])
            pts.append((lat, lon))
    return pts


def sample(grid: np.ndarray, geo: tuple, lat: float, lon: float) -> float | None:
    """Nearest wet model cell; small spiral search rides a lattice point that
    lands on the model's land mask (bays, shore-adjacent cells)."""
    la1, lo1, di, dj = geo
    lon360 = lon % 360
    ix = round((lon360 - lo1) / di)
    iy = round((lat - la1) / dj)
    nj, ni = grid.shape
    for radius in range(0, 8):
        best = None
        best_d = None
        for oy in range(-radius, radius + 1):
            for ox in range(-radius, radius + 1):
                if max(abs(ox), abs(oy)) != radius:
                    continue
                x, y = ix + ox, iy + oy
                if 0 <= x < ni and 0 <= y < nj and not math.isnan(grid[y, x]):
                    d = ox * ox + oy * oy
                    if best_d is None or d < best_d:
                        best, best_d = grid[y, x], d
        if best is not None:
            return float(best)
    return None


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent.parent / "app" / "public" / "data" / "waves-superior.json")

    run = latest_run()
    if not run:
        print("no complete RDWPS run found", file=sys.stderr)
        return 1
    day, hh = run
    run_iso = f"{day[:4]}-{day[4:6]}-{day[6:]}T{hh}:00Z"
    print(f"run {run_iso}")

    pts = lattice()
    cells = [{v: [None] * (HOURS + 1) for v in VARS.values()} for _ in pts]
    times = []
    run_dt = datetime.strptime(day + hh, "%Y%m%d%H").replace(tzinfo=timezone.utc)

    for fh in range(HOURS + 1):
        t = run_dt + timedelta(hours=fh)
        times.append(t.strftime("%Y-%m-%dT%H:%M"))  # Open-Meteo's UTC format
        for var, key in VARS.items():
            data = fetch(grib_url(day, hh, var, fh))
            if data is None:
                continue  # a missing hour stays null; the app falls back
            try:
                grid, geo = decode(data)
            except (ValueError, KeyError, struct.error) as e:
                print(f"  {var} PT{fh:03d}H: {e}", file=sys.stderr)
                continue
            for k, (lat, lon) in enumerate(pts):
                v = sample(grid, geo, lat, lon)
                if v is not None:
                    nd = 0 if key == "waveDir" else (2 if key == "waveM" else 1)
                    cells[k][key][fh] = round(v, nd)
        if fh % 12 == 0:
            print(f"  +{fh:02d}h done")

    got = sum(1 for c in cells for v in c["waveM"] if v is not None)
    total = len(cells) * (HOURS + 1)
    print(f"coverage {got}/{total} cell-hours with heights")
    if got < total * 0.5:
        print("too sparse — refusing to write", file=sys.stderr)
        return 1

    payload = {
        "model": "rdwps-superior-1km",
        "run": run_iso,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": REGION,
        "cols": COLS,
        "rows": ROWS,
        "time": times,
        "cells": cells,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
