"""
Surf spot discovery pipeline.

Reads a seafloor depth grid (NOAA ETOPO 2022, ~450 m cells), walks the whole
coastline, and for every stretch of coast works out:

  * which swell directions can physically reach it (the "swell window") by
    casting rays out to sea and checking whether islands or headlands block them
  * which way the coast faces
  * how the seafloor shoals in front of it (depth profile, slope)
  * whether it sits on a headland/point, in a bay, or on straight coast
  * whether there is an offshore ridge/shoal that could focus swell onto it

The result is written to app/data/spots.json, which the web app scores against
live swell, wind and tide forecasts.

Run it with:   python pipeline/build_spots.py
(The first run downloads ~24 MB of depth data into pipeline/cache/.)
"""

from __future__ import annotations

import json
import math
import urllib.request
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.io import netcdf_file

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "cache"
OUT = ROOT / "app" / "data"

# Area covered: Columbia River mouth (46°N) to the Alaska border (54.8°N).
BBOX = dict(lat_min=46.0, lat_max=54.8, lon_min=-134.0, lon_max=-122.3)
ETOPO_URL = (
    "https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc"
    "?z%5B({lat_min}):1:({lat_max})%5D%5B({lon_min}):1:({lon_max})%5D"
).format(**BBOX)

EARTH_R = 6_371_000.0  # metres

# --- Tunable settings -------------------------------------------------------
N_BINS = 72                   # swell-window resolution: 72 bins of 5 degrees
BIN_DEG = 360 / N_BINS
NEAR_KM = 25                  # near-field ray length (full-resolution grid)
FAR_KM = 500                  # far-field ray length (coarse grid)
LAND_BLOCK_KM = 1.0           # a ray is blocked once it has crossed this much land
                              # (swell wraps around rocks and islets smaller than this)
MIN_WINDOW_DEG = 15           # drop spots that see less than this much open ocean
SPACING_KM = 1.0              # roughly one candidate per km of exposed coast
KNOWN_RADIUS_KM = 3.0
MAX_DEPTH_1KM = 150           # deeper than this 1 km out = no shelf, no surf (drops cliffs/seamounts)
SHALLOW_M = 3.0               # water shallower than this counts as bar / tidal flat
SHALLOW_SKIP_KM = 1.5         # ...but not right in front of the spot (every beach is shallow there)
SHALLOW_BLOCK_KM = 2.0        # crossing this much bar/flat kills the swell
TIDAL_FLAT_1KM = 2.5          # shallower than this 1 km out = mudflat/estuary, not a surf break
FORECAST_GRID_DEG = 0.25      # spots share a forecast within ~15-25 km (keeps API calls low)


# ---------------------------------------------------------------------------
# Loading data
# ---------------------------------------------------------------------------

def load_bathymetry():
    """Return (lat[], lon[], z[lat, lon]) with z in metres (negative = underwater)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / "etopo_pnw.nc"
    if not path.exists():
        print("Downloading ETOPO 2022 depth grid (~24 MB)...")
        urllib.request.urlretrieve(ETOPO_URL, path)
    f = netcdf_file(path, "r", mmap=False)
    lat = f.variables["latitude"][:].astype(np.float64)
    lon = f.variables["longitude"][:].astype(np.float64)
    z = f.variables["z"][:].astype(np.float32)
    f.close()
    return lat, lon, z


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "surf-forecast-pipeline"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def load_tide_stations():
    """Tide prediction stations for BC (DFO) and Washington (NOAA). Cached."""
    path = CACHE / "tide_stations.json"
    if path.exists():
        return json.loads(path.read_text())
    stations = []
    dfo = fetch_json("https://api-iwls.dfo-mpo.gc.ca/api/v1/stations?chs-region-code=PAC")
    for s in dfo:
        if any(t["code"] == "wlp-hilo" for t in s.get("timeSeries", [])):
            stations.append(dict(src="dfo", id=s["id"], code=s["code"],
                                 name=s["officialName"], lat=s["latitude"], lon=s["longitude"]))
    noaa = fetch_json("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"
                      "?type=tidepredictions")["stations"]
    for s in noaa:
        if s.get("state") in ("WA", "OR"):
            stations.append(dict(src="noaa", id=s["id"], code=s["id"],
                                 name=s["name"], lat=s["lat"], lon=s["lng"]))
    stations = [s for s in stations
                if BBOX["lat_min"] - 0.5 <= s["lat"] <= BBOX["lat_max"] + 0.5
                and BBOX["lon_min"] - 0.5 <= s["lon"] <= BBOX["lon_max"] + 0.5]
    path.write_text(json.dumps(stations))
    return stations


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R / 1000 * np.arcsin(np.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


class Grid:
    """Converts between grid cells and metres. Rows are latitude, columns longitude."""

    def __init__(self, lat, lon):
        self.lat, self.lon = lat, lon
        self.dlat = float(lat[1] - lat[0])
        self.dlon = float(lon[1] - lon[0])
        self.dy_m = EARTH_R * math.radians(self.dlat)          # metres per row

    def dx_m(self, lat_deg):                                     # metres per column
        return EARTH_R * math.radians(self.dlon) * np.cos(np.radians(lat_deg))

    def row_lat(self, i):
        return self.lat[0] + i * self.dlat

    def col_lon(self, j):
        return self.lon[0] + j * self.dlon


def cast_rays(mask, grid, rows, cols, bearings_deg, max_km, step_km, block_km,
              start_km=0.0, cell_scale=1, shallow=None):
    """
    March rays outwards from many starting cells at once.

    mask        : 2-D bool array, True = land (may be a coarsened grid)
    rows, cols  : starting positions in *full-resolution* cell units (floats)
    cell_scale  : how many full-res cells make one cell of `mask`
    shallow     : optional bool array (same grid as mask), True = very shallow water.
                  Swell crossing more than SHALLOW_BLOCK_KM of it (beyond the first
                  SHALLOW_SKIP_KM) breaks on bars/flats and never arrives.
    Returns (open, end_rows, end_cols): open is a bool per ray (False if blocked).
    A ray that leaves the west or south edge of the grid counts as open ocean;
    leaving north or east counts as blocked (that's land/Alaska inside waters).
    """
    n = len(rows)
    r = rows.astype(np.float64).copy()
    c = cols.astype(np.float64).copy()
    th = np.radians(bearings_deg)
    dr_per_km = np.cos(th) * 1000 / grid.dy_m
    land_km = np.zeros(n)
    shallow_km = np.zeros(n)
    travelled = 0.0
    alive = np.ones(n, dtype=bool)
    is_open = np.zeros(n, dtype=bool)
    H, W = mask.shape
    steps = int(round((max_km - start_km) / step_km))

    # jump to the start distance (used by the far-field pass)
    if start_km > 0:
        lat_now = grid.row_lat(r)
        r += dr_per_km * start_km
        c += np.sin(th) * start_km * 1000 / grid.dx_m(lat_now)

    for _ in range(steps):
        travelled += step_km
        idx = np.nonzero(alive)[0]
        if idx.size == 0:
            break
        lat_now = grid.row_lat(r[idx])
        r[idx] += dr_per_km[idx] * step_km
        c[idx] += np.sin(th[idx]) * step_km * 1000 / grid.dx_m(lat_now)
        mr = np.floor(r[idx] / cell_scale).astype(int)
        mc = np.floor(c[idx] / cell_scale).astype(int)

        out_ws = (mc < 0) | (mr < 0)                      # left via west/south: open sea
        out_ne = (mc >= W) | (mr >= H)                    # left via north/east: treat as blocked
        inside = ~(out_ws | out_ne)
        is_open[idx[out_ws]] = True
        alive[idx[out_ws | out_ne]] = False

        ii = idx[inside]
        hit = mask[mr[inside], mc[inside]]
        land_km[ii[hit]] += step_km
        blocked = ii[land_km[ii] >= block_km]
        alive[blocked] = False
        if shallow is not None and travelled > SHALLOW_SKIP_KM:
            sh = shallow[mr[inside], mc[inside]]
            shallow_km[ii[sh]] += step_km
            alive[ii[shallow_km[ii] >= SHALLOW_BLOCK_KM]] = False

    is_open |= alive            # survived the full distance without hitting land
    return is_open, r, c


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def main():
    lat, lon, z = load_bathymetry()
    grid = Grid(lat, lon)
    H, W = z.shape
    print(f"Grid {H} x {W}, cell ~{grid.dy_m:.0f} m north-south")

    land = z > 0
    # 1) Keep only sea that connects to the open Pacific (drop lakes)
    sea_labels, _ = ndimage.label(~land)
    pacific_ids = np.unique(sea_labels[:, 0])
    pacific_ids = pacific_ids[pacific_ids > 0]
    pacific = np.isin(sea_labels, pacific_ids)
    land = ~pacific          # lakes count as land from the ocean's point of view

    # 2) Coastal cells: sea cells touching land
    coast = pacific & ndimage.binary_dilation(land, structure=np.ones((3, 3)))
    ci, cj = np.nonzero(coast)
    print(f"Coastal cells: {ci.size:,}")

    # 3) Quick screen: does this cell see open water at least 25 km out in a few directions?
    n_quick = 36
    open_count = np.zeros(ci.size, dtype=int)
    for b in np.arange(n_quick) * (360 / n_quick):
        ok, _, _ = cast_rays(land, grid, ci + 0.5, cj + 0.5, np.full(ci.size, b),
                             max_km=NEAR_KM, step_km=0.3, block_km=LAND_BLOCK_KM)
        open_count += ok
    keep = open_count >= 3
    ci, cj = ci[keep], cj[keep]
    print(f"Coastal cells with some sea view: {ci.size:,}")

    # 4) Thin out to roughly one candidate per SPACING_KM of coast
    clat = grid.row_lat(ci + 0.5)
    clon = grid.col_lon(cj + 0.5)
    by = np.floor(clat / (SPACING_KM / 111.0)).astype(int)
    bx = np.floor(clon * np.cos(np.radians(clat)) / (SPACING_KM / 111.0)).astype(int)
    # prefer the cell with the best quick sea view inside each bucket
    order = np.lexsort((-open_count[keep], bx, by))
    _, first = np.unique(np.stack([by[order], bx[order]], axis=1), axis=0, return_index=True)
    sel = order[first]
    ci, cj = ci[sel], cj[sel]
    n = ci.size
    print(f"Candidates after thinning: {n:,}")

    # 5) Full swell window: 72 rays per candidate, near field on the fine grid,
    #    far field on a coarse grid where tiny islets disappear.
    k = 4
    Hc, Wc = H // k, W // k
    coarse_land = land[:Hc * k, :Wc * k].reshape(Hc, k, Wc, k).mean(axis=(1, 3)) > 0.5
    shallow = pacific & (z > -SHALLOW_M)
    window = np.zeros((n, N_BINS), dtype=bool)
    for bi in range(N_BINS):
        b = np.full(n, bi * BIN_DEG)
        near_ok, r_end, c_end = cast_rays(land, grid, ci + 0.5, cj + 0.5, b,
                                          max_km=NEAR_KM, step_km=0.3,
                                          block_km=LAND_BLOCK_KM, shallow=shallow)
        far_ok = np.zeros(n, dtype=bool)
        idx = np.nonzero(near_ok)[0]
        if idx.size:
            ok2, _, _ = cast_rays(coarse_land, grid, r_end[idx], c_end[idx], b[idx],
                                  max_km=FAR_KM - NEAR_KM, step_km=1.5,
                                  block_km=2.0, cell_scale=k)
            far_ok[idx] = ok2
        window[:, bi] = far_ok
    # How much open water surrounds the spot within 8 km (rivers and inlets are hemmed in)
    sea8 = np.zeros(n)
    for bi in range(N_BINS):
        ok, _, _ = cast_rays(land, grid, ci + 0.5, cj + 0.5, np.full(n, bi * BIN_DEG),
                             max_km=8, step_km=0.3, block_km=0.6)
        sea8 += ok
    sea8 /= N_BINS
    width = window.sum(axis=1) * BIN_DEG
    keep = width >= MIN_WINDOW_DEG
    ci, cj, window, width, sea8 = ci[keep], cj[keep], window[keep], width[keep], sea8[keep]
    n = ci.size
    print(f"Candidates exposed to ocean swell: {n:,}")

    # 6) Per-candidate shape analysis
    zs = ndimage.gaussian_filter(np.where(land, 5.0, z), sigma=3)   # smoothed seafloor
    lap = ndimage.laplace(zs)                                        # >0 trough, <0 ridge
    stations = load_tide_stations()
    st_lat = np.array([s["lat"] for s in stations])
    st_lon = np.array([s["lon"] for s in stations])
    known = json.loads((ROOT / "pipeline" / "known_spots.json").read_text())["spots"]
    kn_lat = np.array([s["lat"] for s in known])
    kn_lon = np.array([s["lon"] for s in known])

    spots = []
    for s in range(n):
        i0, j0 = int(ci[s]), int(cj[s])
        la, lo = float(grid.row_lat(i0 + 0.5)), float(grid.col_lon(j0 + 0.5))
        dx = float(grid.dx_m(la))

        # Facing: point away from the land around us (weighted by closeness)
        rad_r, rad_c = 4, int(math.ceil(1500 / dx))
        sub = land[max(i0 - rad_r, 0):i0 + rad_r + 1, max(j0 - rad_c, 0):j0 + rad_c + 1]
        rr, cc = np.nonzero(sub)
        rr = rr + max(i0 - rad_r, 0) - i0
        cc = cc + max(j0 - rad_c, 0) - j0
        north = rr * grid.dy_m
        east = cc * dx
        d = np.hypot(north, east)
        m = (d > 0) & (d <= 1500)
        if m.sum():
            vn, ve = -(north[m] / d[m] ** 2).sum(), -(east[m] / d[m] ** 2).sum()
            facing = (math.degrees(math.atan2(ve, vn)) + 360) % 360
        else:
            facing = circular_mean(np.nonzero(window[s])[0] * BIN_DEG)

        # How much of the surroundings is land (headland vs bay)
        rad_r2, rad_c2 = int(2500 / grid.dy_m), int(2500 / dx)
        sub2 = land[max(i0 - rad_r2, 0):i0 + rad_r2 + 1, max(j0 - rad_c2, 0):j0 + rad_c2 + 1]
        yy, xx = np.mgrid[0:sub2.shape[0], 0:sub2.shape[1]]
        yy = (yy + max(i0 - rad_r2, 0) - i0) * grid.dy_m
        xx = (xx + max(j0 - rad_c2, 0) - j0) * dx
        disk = np.hypot(yy, xx) <= 2500
        land_frac = float(sub2[disk].mean())

        # Depth profile straight out from the coast
        dists = [0.25, 0.5, 1, 2, 3, 5, 8]
        profile = [round(float(-sample(z, grid, i0, j0, facing, km)), 1) for km in dists]
        # Offshore ridge/shoal (refraction focusing) along the first 1-6 km
        ridge = -np.mean([sample(lap, grid, i0, j0, facing, km) for km in (1, 2, 3, 4, 6)])

        # How deep is it 6 km out along the directions swell arrives from? Shallow = estuary/bar path
        open_bins = np.nonzero(window[s])[0]
        open_depth = float(np.median([-sample(z, grid, i0, j0, b * BIN_DEG, 6) for b in open_bins]))

        # Where to read the offshore forecast: >=4 km out and >=40 m deep (if possible)
        fkm = 4.0
        while fkm < 20 and -sample(z, grid, i0, j0, facing, fkm) < 40:
            fkm += 1.0
        f_lat, f_lon = offset(la, lo, facing, fkm)

        # Nearest tide station & known spot
        dst = haversine_km(la, lo, st_lat, st_lon)
        st = int(np.argmin(dst))
        dkn = haversine_km(la, lo, kn_lat, kn_lon)
        kn = int(np.argmin(dkn))

        spots.append(dict(
            lat=round(la, 4), lon=round(lo, 4),
            facing=round(facing),
            window=pack_window(window[s]),
            windowDeg=int(width[s]),
            landFrac=round(land_frac, 2),
            sea8=round(float(sea8[s]), 2),
            openDepth=round(open_depth, 1),
            # Fraction of swell height that survives the trip over shallow ground (bars,
            # estuaries, wide flats). 1 = deep, clean approach; 0.3 = most of it is lost.
            shelf=round(float(np.clip((open_depth - 4) / 10, 0.3, 1.0)), 2),
            ridge=round(float(ridge), 3),
            profile=profile,
            fLat=round(f_lat, 3), fLon=round(f_lon, 3),
            tide=st, tideKm=round(float(dst[st]), 1),
            near=stations[st]["name"],
            nearBearing=round(bearing_deg(stations[st]["lat"], stations[st]["lon"], la, lo)),
            known=known[kn]["name"] if dkn[kn] <= KNOWN_RADIUS_KM else None,
        ))

    finalize(spots, stations)


def finalize(spots, stations):
    # Normalise the ridge index into roughly -1..1 so the app can use it directly
    ridges = np.array([s["ridge"] for s in spots])
    scale = np.percentile(np.abs(ridges), 90) or 1.0
    for s in spots:
        s["ridge"] = round(float(np.clip(s["ridge"] / scale, -1, 1)), 2)
        s["type"] = classify(s)
        s["region"] = region(s["lat"], s["lon"])
        s["potential"] = potential(s)

    spots[:] = [s for s in spots if s["profile"][2] <= MAX_DEPTH_1KM]

    # Group forecast points onto a coarse grid so the app makes fewer requests
    cells = {}
    for s in spots:
        key = (round(s["fLat"] / FORECAST_GRID_DEG), round(s["fLon"] / FORECAST_GRID_DEG))
        cells.setdefault(key, []).append(s)
    fpoints = []
    for fi, (key, members) in enumerate(sorted(cells.items())):
        fpoints.append([round(float(np.mean([m["fLat"] for m in members])), 3),
                        round(float(np.mean([m["fLon"] for m in members])), 3)])
        for m in members:
            m["fp"] = fi
    for s in spots:
        del s["fLat"], s["fLon"]

    spots.sort(key=lambda s: (-s["lat"], s["lon"]))
    for i, s in enumerate(spots):
        s["id"] = f"PNW-{i + 1:04d}"

    OUT.mkdir(parents=True, exist_ok=True)
    out = dict(
        generated="ETOPO 2022 15 arc-second bathymetry; see pipeline/build_spots.py",
        bbox=BBOX,
        binDeg=BIN_DEG,
        forecastPoints=fpoints,
        tideStations=[dict(src=t["src"], id=t["id"], name=t["name"],
                           lat=round(t["lat"], 4), lon=round(t["lon"], 4)) for t in stations],
        spots=spots,
    )
    (OUT / "spots.json").write_text(json.dumps(out, separators=(",", ":")))
    n_known = sum(1 for s in spots if s["known"])
    print(f"Wrote {len(spots):,} spots ({n_known} near known breaks), "
          f"{len(fpoints)} forecast points -> app/data/spots.json")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def offset(lat, lon, bearing, km):
    th = math.radians(bearing)
    dlat = km * math.cos(th) / 111.195
    dlon = km * math.sin(th) / (111.195 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def sample(arr, grid, i0, j0, bearing, km):
    """Value of `arr` at `km` along `bearing` from cell (i0, j0) (nearest cell)."""
    la = grid.row_lat(i0 + 0.5)
    th = math.radians(bearing)
    i = int(round(i0 + km * 1000 * math.cos(th) / grid.dy_m))
    j = int(round(j0 + km * 1000 * math.sin(th) / float(grid.dx_m(la))))
    i = min(max(i, 0), arr.shape[0] - 1)
    j = min(max(j, 0), arr.shape[1] - 1)
    return float(arr[i, j])


def circular_mean(degs):
    if len(degs) == 0:
        return 270.0
    r = np.radians(degs)
    return (math.degrees(math.atan2(np.sin(r).mean(), np.cos(r).mean())) + 360) % 360


def pack_window(bits):
    """72 true/false values -> 18-character hex string (bin 0 = due north)."""
    s = "".join("1" if b else "0" for b in bits)
    return "".join(f"{int(s[i:i + 4], 2):x}" for i in range(0, len(s), 4))


def classify(s):
    if s["landFrac"] < 0.12:
        return "islet"           # offshore rock, islet or reef tip
    if s["landFrac"] <= 0.28:
        return "point"           # sticks out: headland or point
    if s["landFrac"] >= 0.62:
        return "cove"            # tucked in: bay, cove, inlet mouth
    if s["profile"][2] < 8:
        return "flat-shelf"      # shallow a long way out: beach or reef flat
    return "coast"


def potential(s):
    """How promising the geography looks, 0..1, before any forecast is applied."""
    p = 0.5
    # A moderate swell window is ideal: enough to get swell, some shelter from wind/chop
    w = s["windowDeg"]
    p += 0.15 if 40 <= w <= 140 else (0.05 if w > 140 else -0.1)
    # Points and offshore ridges focus and organise swell
    if s["type"] == "point":
        p += 0.15
    elif s["type"] == "islet":
        p += 0.05            # can be an outer reef, but often just a rock in deep water
    p += 0.12 * s["ridge"]
    # Seafloor: need it to shoal within a few km, but not be a cliff dropping into deep water
    d250, d1k, d3k = s["profile"][0], s["profile"][2], s["profile"][4]
    if d250 > 30:
        p -= 0.25            # deep water right at the shore: waves slam rock, little to ride
    elif 3 <= d1k <= 25 and d3k <= 60:
        p += 0.1             # steady shoaling: classic surfable gradient
    if d3k < 6:
        p -= 0.1             # extremely shallow far out: swell bleeds energy before arriving
    if s["sea8"] < 0.25 and w <= 60:
        p -= 0.1             # hemmed in (river, inlet, deep in a bay): swell fades on the way in
    if d1k < TIDAL_FLAT_1KM:
        p -= 0.3             # mudflat / estuary: swell is long gone by the time it gets here
    return round(float(np.clip(p, 0, 1)), 2)


REGIONS = [
    # (name, lat_min, lat_max, lon_min, lon_max) checked in order
    ("Dixon Entrance (Alaska side)", 54.62, 55.0, -134.0, -130.0),
    ("Haida Gwaii", 51.8, 54.62, -133.6, -130.9),
    ("North Coast", 53.0, 54.62, -131.0, -129.0),
    ("Central Coast", 51.0, 53.0, -131.0, -127.3),
    ("Cape Scott & North Island", 50.3, 51.0, -129.5, -127.3),
    ("Nootka & Kyuquot", 49.6, 50.3, -128.3, -126.3),
    ("Hesquiat & Estevan Point", 49.2, 49.6, -127.0, -126.2),
    ("Clayoquot & Tofino", 49.0, 49.6, -126.2, -125.5),
    ("Ucluelet & Barkley Sound", 48.6, 49.05, -125.9, -124.9),
    ("Pachena to Port Renfrew", 48.5, 48.8, -125.2, -124.4),
    ("Juan de Fuca (BC)", 48.25, 48.7, -124.9, -123.3),
    ("Strait of Juan de Fuca (WA)", 47.95, 48.25, -124.6, -122.3),
    ("Olympic Coast", 47.3, 48.45, -125.0, -124.2),
    ("SW Washington", 46.0, 47.3, -124.4, -123.7),
]


def region(lat, lon):
    for name, a, b, c, d in REGIONS:
        if a <= lat <= b and c <= lon <= d:
            return name
    return "Inside waters"


if __name__ == "__main__":
    main()
