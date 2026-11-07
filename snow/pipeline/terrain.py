"""
Terrain analysis on a ~30 m grid: slope, aspect, curvature, forest cover,
treeline and elevation bands, plus the coarser (~90 m) grids used for routing
and wind sheltering.

Grid convention: geographic (lat/lon) cells of 1" north-south x 1.5" east-west,
which is close to square (~31 x 30 m) at these latitudes. Row 0 is the north edge.
"""

from __future__ import annotations

import math

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.warp import reproject, Resampling
from rasterio.windows import from_bounds
from scipy import ndimage

EARTH_R = 6_371_000.0
RES_LAT = 1 / 3600
RES_LON = 1.5 / 3600


class Grid:
    def __init__(self, bbox, shape, transform):
        self.bbox, self.shape, self.transform = bbox, shape, transform
        self.H, self.W = shape
        self.lat_top = transform.f
        self.lon_left = transform.c
        self.dy = EARTH_R * math.radians(RES_LAT)                  # metres per row
        rows = np.arange(self.H)
        self.row_lat = self.lat_top - (rows + 0.5) * RES_LAT
        self.dx_row = EARTH_R * math.radians(RES_LON) * np.cos(np.radians(self.row_lat))

    def cell(self, lat, lon):
        i = np.floor((self.lat_top - np.asarray(lat)) / RES_LAT).astype(int)
        j = np.floor((np.asarray(lon) - self.lon_left) / RES_LON).astype(int)
        return i, j

    def inside(self, i, j):
        return (i >= 0) & (i < self.H) & (j >= 0) & (j < self.W)

    def latlon(self, i, j):
        return self.lat_top - (np.asarray(i) + 0.5) * RES_LAT, self.lon_left + (np.asarray(j) + 0.5) * RES_LON


def load_dem(paths, bbox):
    srcs = [rasterio.open(p) for p in paths]
    bounds = (bbox["lon_min"], bbox["lat_min"], bbox["lon_max"], bbox["lat_max"])
    z, transform = merge(srcs, bounds=bounds, res=(RES_LON, RES_LAT), resampling=Resampling.bilinear,
                         nodata=-9999)
    for s in srcs:
        s.close()
    z = z[0].astype(np.float32)
    z[z < -100] = np.nan
    return z, Grid(bbox, z.shape, transform)


# ESA WorldCover classes
WC_TREE, WC_SHRUB, WC_GRASS, WC_BARE, WC_SNOW, WC_WATER, WC_WETLAND, WC_MOSS = 10, 20, 30, 60, 70, 80, 90, 100


def load_cover(paths, grid: Grid):
    """Forest fraction (0..1) and dominant class for every grid cell, from 10 m WorldCover."""
    tree = np.zeros(grid.shape, np.float32)
    cls = np.zeros(grid.shape, np.uint8)
    b = grid.bbox
    for p in paths:
        with rasterio.open(p) as src:
            sb = src.bounds
            x0, x1 = max(b["lon_min"], sb.left), min(b["lon_max"], sb.right)
            y0, y1 = max(b["lat_min"], sb.bottom), min(b["lat_max"], sb.top)
            if x0 >= x1 or y0 >= y1:
                continue
            win = from_bounds(x0, y0, x1, y1, src.transform).round_offsets().round_lengths()
            a = src.read(1, window=win)
            wt = src.window_transform(win)
            t_part = np.zeros(grid.shape, np.float32)
            c_part = np.zeros(grid.shape, np.uint8)
            reproject((a == WC_TREE).astype(np.float32), t_part, src_transform=wt, src_crs=src.crs,
                      dst_transform=grid.transform, dst_crs=src.crs, resampling=Resampling.average,
                      src_nodata=None, dst_nodata=0)
            reproject(a, c_part, src_transform=wt, src_crs=src.crs, dst_transform=grid.transform,
                      dst_crs=src.crs, resampling=Resampling.mode, src_nodata=0, dst_nodata=0)
            got = c_part > 0
            tree[got] = t_part[got]
            cls[got] = c_part[got]
            del a
    return tree, cls


def derivatives(z, grid: Grid):
    """Slope (deg), aspect the slope faces (deg, 0 = north), smoothed aspect, curvature."""
    zf = np.where(np.isnan(z), np.nanmean(z), z)
    zs = ndimage.gaussian_filter(zf, 1.0)
    gy, gx = np.gradient(zs)
    dzdx = gx / grid.dx_row[:, None]
    dzdy = -gy / grid.dy                      # rows run south, so flip for "north is up"
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype(np.float32)
    # Downhill direction = the way the slope faces
    e, n = -dzdx, -dzdy
    aspect = ((np.degrees(np.arctan2(e, n)) + 360) % 360).astype(np.float32)
    # Facet-scale aspect: average the downhill vectors over ~180 m so small bumps
    # don't shatter one slope into many pieces
    norm = np.hypot(e, n) + 1e-9
    es = ndimage.gaussian_filter(e / norm, 6.0)
    ns = ndimage.gaussian_filter(n / norm, 6.0)
    aspect_s = ((np.degrees(np.arctan2(es, ns)) + 360) % 360).astype(np.float32)
    # Curvature at ~60 m scale: > 0 gully / bowl bottom, < 0 ridge / convex roll
    lap = ndimage.gaussian_laplace(zf, 2.0) / (grid.dy ** 2)
    return slope, aspect, aspect_s, lap.astype(np.float32)


def treeline(z, slope, tree, cls, grid: Grid, block_deg=0.1):
    """Estimate where forest gives way to open terrain, block by block.

    Returns two grids, t_lo (top of continuous forest) and t_hi (start of the
    alpine). Avalanche forecasts use three bands: below treeline (forest), treeline
    (the transition) and alpine (above the trees). The forecasts don't publish
    fixed elevations, so we read the transition from the land-cover data.
    """
    H, W = grid.shape
    bi = max(1, int(round(block_deg / RES_LAT)))
    bj = max(1, int(round(block_deg / RES_LON)))
    nbi, nbj = (H + bi - 1) // bi, (W + bj - 1) // bj
    lo = np.full((nbi, nbj), np.nan)
    hi = np.full((nbi, nbj), np.nan)
    usable = (slope < 45) & (cls != WC_WATER) & (cls != WC_SNOW) & ~np.isnan(z) & (cls != 0)
    for a in range(nbi):
        for b in range(nbj):
            sl = (slice(a * bi, (a + 1) * bi), slice(b * bj, (b + 1) * bj))
            m = usable[sl]
            if m.sum() < 2000:
                continue
            zz = z[sl][m]
            tt = tree[sl][m]
            bins = (np.clip(zz, 0, None) // 50).astype(int)
            counts = np.bincount(bins)
            frac = np.bincount(bins, weights=tt) / np.maximum(counts, 1)
            ok = counts >= 150
            if ok.sum() < 6:
                continue
            levels = np.nonzero(ok)[0]
            f = frac[levels]
            # smooth across neighbouring 50 m bands
            f = np.convolve(np.pad(f, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
            forest = levels[f >= 0.5]
            if forest.size == 0 or levels.max() * 50 < 1200:
                continue
            top_forest = forest.max() * 50 + 25
            above = levels[(levels * 50 > top_forest)]
            fa = f[np.isin(levels, above)]
            open_ = above[fa < 0.12]
            if open_.size == 0:
                continue
            alpine = open_.min() * 50 + 25
            lo[a, b], hi[a, b] = top_forest, alpine
    # Keep the transition band between 150 and 450 m thick and fill gaps with neighbours
    thick = np.clip(hi - lo, 150, 450)
    mid = (hi + lo) / 2
    good = ~np.isnan(mid)
    if not good.any():
        raise RuntimeError("could not estimate treeline anywhere")
    fill_mid = _fill_smooth(mid, good)
    fill_thick = _fill_smooth(np.where(good, thick, np.nan), good)
    t_lo_b = fill_mid - fill_thick / 2
    t_hi_b = fill_mid + fill_thick / 2
    # Expand blocks back to cells (bilinear between block centres)
    t_lo = _upsample(t_lo_b, H, W, bi, bj)
    t_hi = _upsample(t_hi_b, H, W, bi, bj)
    return t_lo.astype(np.float32), t_hi.astype(np.float32)


def _fill_smooth(a, good, sigma=1.2):
    a = np.where(good, a, np.nanmedian(a[good]))
    w = ndimage.gaussian_filter(good.astype(float), sigma)
    v = ndimage.gaussian_filter(np.where(good, a, 0.0), sigma)
    out = np.where(w > 0.05, v / np.maximum(w, 1e-9), np.nanmedian(a[good]))
    return ndimage.gaussian_filter(out, 0.7)


def _upsample(blocks, H, W, bi, bj):
    nbi, nbj = blocks.shape
    ri = (np.arange(H) + 0.5) / bi - 0.5
    rj = (np.arange(W) + 0.5) / bj - 0.5
    ri = np.clip(ri, 0, nbi - 1)
    rj = np.clip(rj, 0, nbj - 1)
    return ndimage.map_coordinates(blocks, np.meshgrid(ri, rj, indexing="ij"), order=1, mode="nearest")


def bands(z, t_lo, t_hi):
    """0 = below treeline, 1 = treeline, 2 = alpine."""
    b = np.ones(z.shape, np.int8)
    b[z < t_lo] = 0
    b[z >= t_hi] = 2
    return b


# ---------------------------------------------------------------------------
# Coarse grid (~90 m) for routing and wind
# ---------------------------------------------------------------------------

def coarsen(a, k=3, how="mean"):
    H, W = a.shape
    Hc, Wc = H // k, W // k
    v = a[:Hc * k, :Wc * k].reshape(Hc, k, Wc, k)
    if how == "mean":
        return np.nanmean(v, axis=(1, 3))
    if how == "max":
        return np.nanmax(v, axis=(1, 3))
    if how == "any":
        return v.any(axis=(1, 3))
    if how == "center":
        return v[:, k // 2, :, k // 2]
    raise ValueError(how)


DIRS8 = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]  # N, NE, E, ... (row, col)


def wind_shelter(zc, dy, dx_row, max_m=1000):
    """Winstral-style shelter index for 8 wind directions.

    For wind blowing FROM direction d, look upwind (towards d) up to `max_m` and
    take the steepest angle up to the terrain there. Positive = sheltered behind
    higher ground (where blown snow drops: loading); negative = exposed (scouring).
    Returns array [8, Hc, Wc] of tan(angle).
    """
    Hc, Wc = zc.shape
    zf = np.where(np.isnan(zc), np.nanmin(zc), zc)
    out = np.full((8, Hc, Wc), -1.0, np.float32)
    for d, (di, dj) in enumerate(DIRS8):
        step = math.hypot(di * dy, dj * float(np.mean(dx_row)))
        n = max(1, int(max_m // step))
        best = np.full((Hc, Wc), -1.0, np.float32)
        for k in range(1, n + 1):
            sh = _shift(zf, di * k, dj * k)
            ang = (sh - zf) / (step * k)
            best = np.maximum(best, ang)
        out[d] = best
    return out


def _shift(a, di, dj, fill=np.nan):
    """b[i, j] = a[i + di, j + dj] (edge cells get the edge value)."""
    H, W = a.shape
    ii = np.clip(np.arange(H) + di, 0, H - 1)
    jj = np.clip(np.arange(W) + dj, 0, W - 1)
    return a[np.ix_(ii, jj)]


def avalanche_exposure(zc, steep, dy, dx_row, alpha_deg=22, max_m=1600):
    """Cells that are steep (start zones) or could be reached by an avalanche from them.

    A simple "alpha angle" rule: a cell counts as exposed if steep terrain above it
    rises at an angle of at least `alpha_deg` as seen from the cell. Real runouts
    depend on path shape and snow; this only flags where to look closer.
    """
    zf = np.where(np.isnan(zc), np.nanmin(zc), zc)
    exp = steep.copy()
    t = math.tan(math.radians(alpha_deg))
    for di, dj in DIRS8:
        step = math.hypot(di * dy, dj * float(np.mean(dx_row)))
        n = int(max_m // step)
        for k in range(1, n + 1):
            sz = _shift(zf, di * k, dj * k)
            sst = _shift(steep, di * k, dj * k)
            exp |= sst & ((sz - zf) >= t * step * k)
    return exp
