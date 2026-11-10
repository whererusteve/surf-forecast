"""
Run AutoATES v2.0 over a whole region, tile by tile.

AutoATES (Toft et al. 2024, NHESS 24:1779-1793, doi:10.5194/nhess-24-1779-2024) maps
avalanche terrain on the ATES scale: simple / challenging / complex / extreme, using
likely start zones, simulated runout (Flow-Py) and forest density. It is GPL-3.0, so it
runs from its own clone in snow/pipeline/cache/autoates-src (pinned commit below) and
only its output maps come back. Its results are a MODEL ESTIMATE, never an official
ATES rating.

It is slow (about 30-45 minutes per tile on 4 cores), so tiles are cached and the run
resumes where it stopped. Tiles with the most day-trip zones go first.

Run:    python snow/pipeline/autoates_tiles.py [--day-trips] [--hours H] [region ...]
          --day-trips  only tiles with at least DAY_TRIP_MIN zones reachable within 5 h
          --hours H    stop between tiles before H hours have passed, so no tile is cut off
Output: snow/pipeline/cache/autoates/<region>/tile_<i>_<j>.tif  (int16: 1-4, -9999 none)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling, transform_bounds

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sources as S  # noqa: E402
import terrain as T  # noqa: E402
from regions import REGIONS  # noqa: E402

SRC = HERE / "cache" / "autoates-src"
PIN = "3afcb49ae8c8a2385666f6fb4b999c69c82b1e83"
SHIM = HERE / "autoates" / "shim"
OUT = HERE / "cache" / "autoates"
RES = 30.0           # metres (Copernicus GLO-30)
CORE_M = 15000       # tile size kept
PAD_M = 2000         # extra terrain around each tile so runout from just outside is counted
DAY_TRIP_H = 5       # one-way hours that still make a day trip
DAY_TRIP_MIN = 10    # --day-trips skips tiles with fewer day-trip zones than this
FIRST_TILE_GUESS_S = 3000  # time to allow for the next tile, until a slower one is seen (slowest so far ~50 min)


def utm_crs(region):
    lon = (region["bbox"]["lon_min"] + region["bbox"]["lon_max"]) / 2
    return f"EPSG:{32600 + int((lon + 180) // 6) + 1}"


def ensure_source():
    if not SRC.exists():
        subprocess.run(["git", "clone", "-q", "https://github.com/AutoATES/AutoATES-v2.0", str(SRC)], check=True)
    subprocess.run(["git", "-C", str(SRC), "checkout", "-q", PIN], check=True)


def tiles(region, crs):
    b = region["bbox"]
    x0, y0, x1, y1 = transform_bounds("EPSG:4326", crs, b["lon_min"], b["lat_min"], b["lon_max"], b["lat_max"])
    nx, ny = int(np.ceil((x1 - x0) / CORE_M)), int(np.ceil((y1 - y0) / CORE_M))
    for j in range(ny):
        for i in range(nx):
            yield i, j, (x0 + i * CORE_M, y0 + j * CORE_M, x0 + (i + 1) * CORE_M, y0 + (j + 1) * CORE_M)


def priority(rid, crs, bounds_list, day_trips_only=False):
    """Order tiles: most day-trip zones (well-travelled ones count double) first; skip empty tiles.
    With day_trips_only, also skip tiles holding fewer than DAY_TRIP_MIN day-trip zones."""
    from rasterio.warp import transform as tf
    p = HERE.parent / "data" / f"zones-{rid}.json"
    zones = json.loads(p.read_text())["zones"] if p.exists() else []
    if not zones:
        return [(1.0, t) for t in bounds_list]
    xs, ys = tf("EPSG:4326", crs, [z["c"][1] for z in zones], [z["c"][0] for z in zones])
    out = []
    for t in bounds_list:
        _, _, (a, b_, c, d) = t
        score = 0.0
        day = 0
        for z, x, y in zip(zones, xs, ys):
            if a <= x < c and b_ <= y < d:
                best = min(v["h"] for v in z["acc"].values())
                day += best <= DAY_TRIP_H
                score += (3 if best <= DAY_TRIP_H else 1) * (2 if z["use"] == 2 else 1)
        if day_trips_only and day < DAY_TRIP_MIN:
            continue
        if score > 0:
            out.append((score, t))
    return sorted(out, key=lambda s: -s[0])


def prepare(region, crs, box, work):
    """DEM and percent canopy cover for the tile plus padding, on a 30 m UTM grid."""
    a, b_, c, d = box[0] - PAD_M, box[1] - PAD_M, box[2] + PAD_M, box[3] + PAD_M
    lon0, lat0, lon1, lat1 = transform_bounds(crs, "EPSG:4326", a, b_, c, d)
    bb = dict(lat_min=lat0 - 0.01, lat_max=lat1 + 0.01, lon_min=lon0 - 0.01, lon_max=lon1 + 0.01)
    z, g = T.load_dem(S.dem_files(region), bb)
    tree, _ = T.load_cover(S.worldcover_files(region), g)
    W, H = int(round((c - a) / RES)), int(round((d - b_) / RES))
    t = from_origin(a, d, RES, RES)
    zz = np.full((H, W), -9999, np.float32)
    ff = np.zeros((H, W), np.float32)
    reproject(np.nan_to_num(z, nan=-9999), zz, src_transform=g.transform, src_crs="EPSG:4326", dst_transform=t,
              dst_crs=crs, resampling=Resampling.bilinear, src_nodata=-9999, dst_nodata=-9999)
    reproject(tree * 100, ff, src_transform=g.transform, src_crs="EPSG:4326", dst_transform=t, dst_crs=crs,
              resampling=Resampling.bilinear)
    prof = dict(driver="GTiff", width=W, height=H, count=1, crs=crs, transform=t)
    (work / "PRA").mkdir(parents=True, exist_ok=True)
    for name, arr in (("DEM", zz), ("FOREST", ff)):
        with rasterio.open(work / "PRA" / f"{name}.tif", "w", dtype="int16", nodata=-9999, **prof) as dst:
            dst.write(np.round(arr).astype("int16"), 1)
        # Flow-Py keeps running totals in the input's number type, so give it floats
        with rasterio.open(work / "PRA" / f"{name}_f32.tif", "w", dtype="float32", nodata=-9999, **prof) as dst:
            dst.write(arr, 1)
    return float(np.nanmax(np.where(zz > -9999, zz, np.nan)) if (zz > -9999).any() else 0)


def run_tile(region, crs, box, dest):
    work = OUT / "work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    top = prepare(region, crs, box, work)
    env = dict(os.environ, PYTHONPATH=str(SHIM))
    # 1. likely start zones (AutoATES defaults; wind-shelter radius 60 m = 2 cells at 30 m)
    subprocess.run([sys.executable, str(SRC / "PRA" / "PRA_AutoATES-v2.0.py"), "pcc", "PRA/DEM.tif",
                    "PRA/FOREST.tif", "2", "0.5", "0", "180", "0.15", "3"], cwd=work, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with rasterio.open(work / "PRA" / "PRA_binary.tif") as s:
        n_release = int((s.read(1) > 0).sum())
    if n_release == 0:
        write_empty(work, dest, box, crs)
        return 0
    # 2. runout (Flow-Py)
    env2 = dict(os.environ, PYTHONPATH=f"{SHIM}:{SRC / 'FlowPy_detrainment'}")
    subprocess.run([sys.executable, str(HERE / "autoates" / "flowpy_cli.py"), str(work),
                    str(work / "PRA" / "DEM_f32.tif"), str(work / "PRA" / "PRA_binary.tif"),
                    str(work / "PRA" / "FOREST_f32.tif")], env=env2, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    res = sorted(work.glob("res_*"))[-1]
    (work / "inputs").mkdir()
    (work / "outputs").mkdir()
    for src_name, dst_name in (("FP_travel_angle.tif", "FP_int16.tif"), ("cell_counts.tif", "Overhead.tif")):
        with rasterio.open(res / src_name) as s:
            a = s.read(1)
            p = s.profile
        p.update(dtype="int16", nodata=-9999)
        with rasterio.open(work / "inputs" / dst_name, "w", **p) as d:
            d.write(np.where(a > 0, np.round(a), -9999).astype("int16"), 1)   # not reached -> nodata
    # 3. ATES classes: AutoATES's classifier, unchanged except its input paths
    code = (SRC / "AutoATES_classifier.py").read_text()
    subs = {"DEM": work / "PRA" / "DEM.tif", "canopy": work / "PRA" / "FOREST.tif",
            "cell_count": work / "inputs" / "Overhead.tif", "FP": work / "inputs" / "FP_int16.tif",
            "SZ": work / "PRA" / "PRA_binary.tif", "forest_type": "pcc", "wd": work / "outputs"}
    for k, v in subs.items():
        code, n = re.subn(rf"^{k} = .*$", f"{k} = {str(v)!r}", code, count=1, flags=re.M)
        assert n == 1, k
    (work / "classifier.py").write_text(code)
    subprocess.run([sys.executable, str(work / "classifier.py")], cwd=work, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    crop(work / "outputs" / "ates_gen.tif", dest, box)
    return n_release


def crop(src_path, dest, box):
    with rasterio.open(src_path) as s:
        win = rasterio.windows.from_bounds(*box, transform=s.transform).round_offsets().round_lengths()
        a = s.read(1, window=win)
        p = s.profile
        p.update(width=a.shape[1], height=a.shape[0], transform=s.window_transform(win), compress="deflate")
    with rasterio.open(dest, "w", **p) as d:
        d.write(a, 1)


def write_empty(work, dest, box, crs):
    W = H = int(CORE_M / RES)
    p = dict(driver="GTiff", width=W, height=H, count=1, crs=crs, dtype="int16", nodata=-9999,
             transform=from_origin(box[0], box[3], RES, RES), compress="deflate")
    with rasterio.open(dest, "w", **p) as d:
        d.write(np.full((H, W), -9999, np.int16), 1)


def main(rids, day_trips_only=False, hours=None):
    ensure_source()
    start = time.time()
    slowest = FIRST_TILE_GUESS_S
    for rid in rids:
        region = REGIONS[rid]
        crs = utm_crs(region)
        (OUT / rid).mkdir(parents=True, exist_ok=True)
        todo = priority(rid, crs, list(tiles(region, crs)), day_trips_only)
        done = sum(1 for _, (i, j, _) in todo if (OUT / rid / f"tile_{i}_{j}.tif").exists())
        kind = "day-trip tiles" if day_trips_only else "tiles with zones"
        print(f"{rid}: {len(todo)} {kind}, {done} already done", flush=True)
        for score, (i, j, box) in todo:
            dest = OUT / rid / f"tile_{i}_{j}.tif"
            if dest.exists():
                continue
            if hours and time.time() - start + slowest > hours * 3600:
                print(f"TIME UP: stopping before tile {i},{j} to stay within {hours} h", flush=True)
                return
            t0 = time.time()
            try:
                n = run_tile(region, crs, box, dest)
            except subprocess.CalledProcessError as err:
                print(f"  tile {i},{j} failed ({err}); skipping for now", flush=True)
                continue
            done += 1
            slowest = max(slowest, time.time() - t0)
            print(f"  tile {i},{j} (priority {score:.0f}): {n} start cells, {time.time() - t0:.0f} s "
                  f"[{done}/{len(todo)}]", flush=True)
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    day = "--day-trips" in args
    hours = None
    if "--hours" in args:
        k = args.index("--hours")
        hours = float(args[k + 1])
        del args[k:k + 2]
    rids = [a for a in args if not a.startswith("--")] or list(REGIONS)
    main(rids, day_trips_only=day, hours=hours)
