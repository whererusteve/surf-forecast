"""
Backcountry Snow Finder: zone discovery pipeline.

Turns terrain into candidate ZONES: patches of slope with one elevation band and
one aspect, cut to a manageable size, each with
  * its slope-angle mix (<30 / 30-35 / 35-45 / >45 degrees), forest cover, gullies
  * estimated travel time by every legal access mode (skin, sled-assisted, lift)
  * which wind directions load it and which scour it
  * a terrain "potential" score (fall line, pitch, size), kept apart from hazard
  * a use level (well-travelled / occasional / little sign of travel) from open data

Areas that must not be shown (reserves, operating ski resorts, cat-ski tenures,
cultural places documented for cultural use, Steve's curated removals) are cut out
BEFORE zones are drawn. Heli-ski tenures, proposed resorts and other cultural areas
stay in and are highlighted on the zones they overlap.

Run:   python snow/pipeline/build_zones.py [region ...]     (default: all regions)
Output: snow/data/zones-<region>.json, snow/data/regions.json,
        snow/pipeline/exclusions/sources-<region>.json, snow/pipeline/known_zones.json
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from affine import Affine
import rasterio
from rasterio import features
from rasterio.warp import reproject, Resampling
from scipy import ndimage
from shapely.geometry import shape, Point, Polygon, box, mapping
from shapely.ops import unary_union
from shapely.prepared import prep
from skimage.measure import label as cc_label

sys.path.insert(0, str(Path(__file__).resolve().parent))
import access as A  # noqa: E402
import sources as S  # noqa: E402
import terrain as T  # noqa: E402
from regions import REGIONS, WA_ID_BORDER_LON  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "data"

# --- Tunable settings -------------------------------------------------------
MIN_SLOPE = 15          # degrees: flatter ground is approach terrain, not a zone
TILE_M = 3000           # long slopes are cut into pieces about this size
MIN_CELLS = 300         # ~0.28 km2: smaller fragments are dropped
MIN_RELIEF = 80         # metres of vertical needed to be worth a zone
BELOW_TREELINE_M = 500  # zones topping out this far below the forest line are left out
                        # (dense low-elevation forest that rarely holds ridable snow)
MAX_HOURS = 14          # zones further than this one way are left out
CURATED_DROP_FRAC = 0.3 # a curated shape covering this much of a zone removes it
COARSE = 3              # routing grid = 3 x 3 cells (~90 m)
ALPHA_DEG = 25          # "could an avalanche reach here" angle up to steep terrain (simple alpha-angle rule)
MAX_FP = 66             # forecast points per region (x 3 elevation bands <= ~200 calls)
SIMPLIFY_DEG = 0.0004   # polygon simplification for the web (~30-40 m)

# Steve's decision (2026-11-07): heli-ski tenures and proposed ski resorts stay in and
# are highlighted on the zones they overlap. (In BC these tenures don't close the land
# to the public; 16% of Sea-to-Sky MIN reports come from inside them.) Cat-ski tenures
# are still removed.
EXCLUDE_HELI_TENURES = False
HIGHLIGHT_MIN_SHARE = 0.15   # a highlighted area covering this much of a zone is noted on it
CONTENT = ROOT / "content"

USE_LABELS = ["little sign of travel", "occasional", "well-travelled"]


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# Exclusions and access rules from open data
# ---------------------------------------------------------------------------

def gather_exclusions(rid, region, b):
    """Returns list of (source_key, label, [shapely geoms]) to cut out."""
    out = []
    if "CA" in region["country"]:
        res = S.bc_wfs("WHSE_ADMIN_BOUNDARIES.CLAB_INDIAN_RESERVES", b, geom="GEOMETRY")
        out.append(("reserve", "First Nations reserves", [shape(f["geometry"]) for f in res]))
        cra = S.bc_wfs("REG_LEGAL_AND_ADMIN_BOUNDARIES.REC_TENURE_ALPINE_SKI_AREAS_SP", b)
        # Only operating resorts. Proposed ones (e.g. Garibaldi at Squamish on Brohm Ridge,
        # Coquihalla Pass) stay in and are highlighted (Steve, 2026-11-07).
        out.append(("ski_area", "Ski resort areas (BC Controlled Recreation Areas, active)",
                    [shape(f["geometry"]) for f in cra if f["properties"].get("PROJECT_STATUS") == "Active"]))
        ten = S.bc_wfs("WHSE_TANTALIS.TA_CROWN_TENURES_SVW", b,
                       "TENURE_PURPOSE='COMMERCIAL RECREATION' AND TENURE_SUBPURPOSE IN ('HELI SKI','CAT SKI') "
                       "AND TENURE_STAGE='TENURE'")
        if EXCLUDE_HELI_TENURES:
            out.append(("heli_tenure", "Commercial heli-ski tenures",
                        [shape(f["geometry"]) for f in ten if f["properties"]["TENURE_SUBPURPOSE"] == "HELI SKI"]))
        cat = [shape(f["geometry"]) for f in ten if f["properties"]["TENURE_SUBPURPOSE"] == "CAT SKI"]
        out.append(("cat_tenure", "Commercial cat-ski tenures", cat))
        blocked = [a["geom"] for a in cultural_areas(region, b) if a["status"] == "block"]
        out.append(("cultural_place", "Cultural Places documented for cultural use (land-use plans)", blocked))
    if "US" in region["country"]:
        tl = S.us_tribal_lands(b)
        out.append(("tribal", "Tribal reservations and trust lands", [shape(f["geometry"]) for f in tl if f.get("geometry")]))
        ka = json.loads((HERE / "known_access.json").read_text())
        ws = []
        bx = box(*b)
        for r in ka["usResortBboxes"]:
            if bx.intersects(box(*r["bbox"])):
                for p in S.osm_winter_sports_areas(tuple(r["bbox"])):
                    ws.append(Polygon(p["ring"]).buffer(0))
        out.append(("ski_area_us", "Ski resort areas (OpenStreetMap)", ws))
    if region.get("drop_washington"):
        wa = box(b[0] - 1, b[1] - 1, WA_ID_BORDER_LON, 49.0)
        out.append(("washington", "Washington Selkirks (no avalanche forecast)", [wa]))
    return out


FT = 0.3048


def official_bands(region, grid, t_lo, t_hi):
    """Where a US avalanche centre publishes its elevation bands, use them exactly.

    NWAC and IPAC give each forecast zone a middle band in feet (e.g. "5500-4500ft").
    Zones are then banded the same way as the danger rating shown beside them.
    Updates t_lo / t_hi in place; returns the zone names used.
    """
    if "US" not in region["country"]:
        return []
    used = []
    for cid in region["avalanche_centres"]:
        if cid == "avcan":
            continue
        cfg = S.cached_json("avalanche", f"aorg-centre-{cid}", lambda cid=cid: json.loads(
            S.http(f"https://api.avalanche.org/v2/public/avalanche-center/{cid}")))
        geoms = {f["id"]: shape(f["geometry"]) for f in S.aorg_zones()["features"]
                 if f["properties"]["center_id"] == cid}
        for zcfg in cfg.get("zones", []):
            mid = ((zcfg.get("config") or {}).get("elevation_band_names") or {}).get("middle", "")
            nums = [int(x.replace(",", "")) for x in re.findall(r"\d[\d,]{2,}", mid)]
            g = geoms.get(int(zcfg["id"])) or geoms.get(zcfg["id"])
            if len(nums) < 2 or g is None:
                continue
            lo, hi = min(nums) * FT, max(nums) * FT
            m = features.rasterize([(g, 1)], out_shape=grid.shape, transform=grid.transform, fill=0,
                                   dtype="uint8").astype(bool)
            if m.any():
                t_lo[m], t_hi[m] = lo, hi
                used.append(f"{cid} {zcfg['name']}: {lo:.0f}-{hi:.0f} m")
    for u in used:
        log("  official bands:", u)
    return used


def cultural_areas(region, b):
    """Culturally designated areas from BC's land-use plans, with Steve's wording.

    Rules live in snow/content/cultural_areas.json: Cultural Places are blocked,
    Cultural Management Areas flagged, with per-area exceptions (Pipi7iyekw is seasonal).
    """
    if "CA" not in region["country"]:
        return []
    content = json.loads((CONTENT / "cultural_areas.json").read_text())
    fs = S.bc_wfs("WHSE_LAND_USE_PLANNING.RMP_PLAN_LEGAL_POLY_SVW", b,
                  "LEGAL_FEAT_OBJECTIVE IN ('Cultural Places','Cultural Management Area')", geom="GEOMETRY")
    out = []
    for f in fs:
        p = f["properties"]
        attrs = {p.get(f"LEGAL_FEAT_ATRB_{i}_NAME"): (p.get(f"LEGAL_FEAT_ATRB_{i}_VALUE") or "").strip()
                 for i in range(1, 6) if p.get(f"LEGAL_FEAT_ATRB_{i}_NAME")}
        name = attrs.get("LOCATION_NAME") or p["LEGAL_FEAT_OBJECTIVE"]
        objective = p["LEGAL_FEAT_OBJECTIVE"]
        entry = content["areas"].get(name, {})
        kind = content["kinds"]["default"]
        if objective == "Cultural Places":
            for k, v in content["kinds"].items():
                if k not in ("_about", "default") and k in name:
                    kind = v
                    break
        nation_keys = entry.get("nations") or kind.get("nations") or \
            ([attrs["FIRST_NATION"]] if attrs.get("FIRST_NATION") in content["nations"] else [])
        out.append(dict(
            kind="cultural",
            status=entry.get("status") or content["rules"].get(objective, "flag"),
            title=entry.get("title") or name,
            designation=objective,
            why=entry.get("why") or kind["why"],
            nations=[content["nations"][k] for k in nation_keys if k in content["nations"]],
            sources=[content["sources"][k] for k in (entry.get("sources") or kind.get("sources") or [])],
            review=entry.get("review", True),
            geom=shape(f["geometry"]),
        ))
    return out


def highlight_areas(region, b):
    """Areas that stay in the app but are pointed out on the zones they overlap."""
    out = [a for a in cultural_areas(region, b) if a["status"] != "block"]
    if "CA" in region["country"]:
        ten = S.bc_wfs("WHSE_TANTALIS.TA_CROWN_TENURES_SVW", b,
                       "TENURE_PURPOSE='COMMERCIAL RECREATION' AND TENURE_SUBPURPOSE='HELI SKI' "
                       "AND TENURE_STAGE='TENURE'")
        for f in ten:
            out.append(dict(kind="heli", status="flag", title="Commercial heli-ski tenure",
                            why="A commercial heli-ski operator holds a provincial tenure here. The public can "
                                "still travel here, but expect helicopters and guided groups, and give them room. "
                                "(The public tenure data doesn't name the operator.)",
                            sources=[dict(label="BC Crown tenures (TANTALIS)", url="https://catalogue.data.gov.bc.ca/")],
                            geom=shape(f["geometry"])))
        cra = S.bc_wfs("REG_LEGAL_AND_ADMIN_BOUNDARIES.REC_TENURE_ALPINE_SKI_AREAS_SP", b)
        for f in cra:
            pr = f["properties"]
            if pr.get("PROJECT_STATUS") == "Proposed":
                out.append(dict(kind="proposedResort", status="flag", title=f"Proposed ski resort: {pr['RESORT_NAME']}",
                                why="This area is set aside for a proposed ski resort that isn't operating. There "
                                    "are no lifts, no ski patrol and no avalanche control: it's backcountry.",
                                sources=[dict(label="BC Controlled Recreation Areas", url="https://catalogue.data.gov.bc.ca/")],
                                geom=shape(f["geometry"])))
    return out


def area_record(a):
    """Region-level description of a highlighted or blocked area, with a light outline for the map."""
    g = a["geom"].simplify(0.0015, preserve_topology=True)
    polys = [g] if g.geom_type == "Polygon" else list(getattr(g, "geoms", []))
    rings = [[[round(x, 3), round(y, 3)] for x, y in pg.exterior.coords] for pg in polys if pg.area > 1e-6]
    rec = {k: v for k, v in a.items() if k != "geom"}
    rec["rings"] = rings
    return rec


def no_sled_geoms(region, b):
    """Areas where snowmobiles are not allowed."""
    g = []
    if "CA" in region["country"]:
        for lay, geom in (("WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW", "SHAPE"),
                          ("WHSE_TANTALIS.TA_CONSERVANCY_AREAS_SVW", "SHAPE"),
                          ("WHSE_ADMIN_BOUNDARIES.CLAB_NATIONAL_PARKS", "GEOMETRY"),
                          ("WHSE_ADMIN_BOUNDARIES.CLAB_INDIAN_RESERVES", "GEOMETRY")):
            g += [shape(f["geometry"]) for f in S.bc_wfs(lay, b, geom=geom)]
        for f in S.bc_wfs("WHSE_WILDLIFE_INVENTORY.AMA_SNOWMOBILE_MGMT_AREAS_SP", b, geom="GEOMETRY"):
            if (f["properties"].get("AREA_USE") or "").lower().startswith("legal closure"):
                g.append(shape(f["geometry"]))
        for f in S.bc_wfs("WHSE_WILDLIFE_MANAGEMENT.WAA_MVPR_AREAS_SP", b):
            p = f["properties"]
            eff = (p.get("EFFECTIVE_DESCRIPTION") or "").lower()
            exempt = "snowmobile" in (p.get("EXEMPTION") or "").lower()
            if p.get("PROHIBITION_TYPE") == "Motor Vehicle Closed Areas" and not exempt and \
                    ("year round" in eff or "road closure" in eff):
                g.append(shape(f["geometry"]))
    if "US" in region["country"]:
        g += [shape(f["geometry"]) for f in S.us_wilderness(b) if f.get("geometry")]
    return g


def road_lines(region, b, ka, rid):
    """(plowed_lines, sled_lines) as shapely geometries."""
    plowed, sled = [], []
    closures = [box(*c["bbox"]) for c in ka["winterRoadClosures"] if c["region"] == rid]
    if "CA" in region["country"]:
        rd = S.bc_wfs("WHSE_BASEMAPPING.DRA_DGTL_ROAD_ATLAS_MPAR_SP", b, geom="GEOMETRY",
                      props=["ROAD_CLASS", "ROAD_SURFACE"])
        for f in rd:
            c, s = f["properties"]["ROAD_CLASS"], f["properties"]["ROAD_SURFACE"]
            g = shape(f["geometry"])
            if c in ("highway", "freeway", "expressway", "arterial", "collector", "ramp", "yield") or \
                    (c in ("local", "strata") and s == "paved"):
                plowed.append(g)
            elif c in ("resource", "unclassified", "recreation", "local", "restricted", "service"):
                sled.append(g)
    if "US" in region["country"]:
        for f in S.us_roads(b):
            if f.get("geometry"):
                plowed.append(shape(f["geometry"]))
        for f in S.us_snowmobile_trails(b):
            if f.get("geometry"):
                sled.append(shape(f["geometry"]))
    if closures:
        cl = unary_union(closures)
        # closed roads where snowmobiles are allowed become sled routes
        sled_ok = [box(*c["bbox"]) for c in ka["winterRoadClosures"] if c["region"] == rid and c.get("sledOK")]
        if sled_ok:
            so = unary_union(sled_ok)
            sled += [g for g in (p.intersection(so) for p in plowed) if not g.is_empty]
        plowed = [g.difference(cl) for g in plowed]
        plowed = [g for g in plowed if not g.is_empty]
    return plowed, sled


# ---------------------------------------------------------------------------
# Zones
# ---------------------------------------------------------------------------

def segment(ridable, band, aspect_s, grid):
    """Cut ridable slopes into zones: one elevation band, one way of facing, one ~3 km tile.

    Alpine ridges and bowls change direction every few hundred metres, so cutting by
    aspect leaves many pieces under MIN_CELLS. Dropping them lost ~40% of alpine and
    treeline terrain (Steve spotted empty alpine around the Callaghan, 2026-11-11), so:
      1. small pieces join the big neighbour in the same band they share most edge with;
      2. pieces still small are regrouped by band and tile, ignoring which way they face;
      3. only what is still under MIN_CELLS is dropped.
    """
    oct_ = (np.round(aspect_s / 45).astype(np.int32) % 8)
    ti = TILE_M / grid.dy
    tj = TILE_M / float(np.mean(grid.dx_row))
    rows = (np.arange(grid.H) // ti).astype(np.int32)
    cols = (np.arange(grid.W) // tj).astype(np.int32)
    ntj = int(cols.max()) + 1
    tile = rows[:, None] * ntj + cols[None, :]
    nt = int(tile.max()) + 1
    key = (band.astype(np.int32) * 8 + oct_) * nt + tile
    key = np.where(ridable, key, -1)
    lab = cc_label(key, background=-1, connectivity=1).astype(np.int32)
    n = int(lab.max())
    band_of = np.zeros(n + 1, np.int32)
    band_of[lab] = band
    for _ in range(6):
        counts = np.bincount(lab.ravel(), minlength=n + 1)
        big = counts >= MIN_CELLS
        big[0] = False
        lut = _absorb_small(lab, n, big, band_of)
        if lut is None:
            break
        lab = lut[lab]
    counts = np.bincount(lab.ravel(), minlength=n + 1)
    small = (counts < MIN_CELLS) & (np.arange(n + 1) > 0)
    left = small[lab]
    if left.any():
        key2 = np.where(left, band.astype(np.int32) * nt + tile, -1)
        lab2 = cc_label(key2, background=-1, connectivity=1).astype(np.int32)
        lab = np.where(left, 0, lab)
        lab = np.where(lab2 > 0, lab2 + n, lab)
    counts = np.bincount(lab.ravel())
    drop = counts < MIN_CELLS
    drop[0] = True
    lab[drop[lab]] = 0
    return _relabel(lab)


def _absorb_small(lab, n, big, band_of):
    """Map each small piece to the big same-band neighbour it shares the most edge with.
    Returns a label lookup table, or None when no small piece touches a big one."""
    a = np.concatenate([lab[:, :-1].ravel(), lab[:-1, :].ravel()])
    b = np.concatenate([lab[:, 1:].ravel(), lab[1:, :].ravel()])
    m = (a != b) & (a > 0) & (b > 0)
    a, b = a[m], b[m]
    a, b = np.concatenate([a, b]), np.concatenate([b, a])      # both directions
    m = ~big[a] & big[b] & (band_of[a] == band_of[b])
    if not m.any():
        return None
    a, b = a[m].astype(np.int64), b[m].astype(np.int64)
    pair, cnt = np.unique(a * (n + 1) + b, return_counts=True)
    src, dst = pair // (n + 1), pair % (n + 1)
    order = np.lexsort((-cnt, src))                           # per piece, longest shared edge first
    src, dst = src[order], dst[order]
    first = np.r_[True, src[1:] != src[:-1]]
    lut = np.arange(n + 1, dtype=np.int32)
    lut[src[first]] = dst[first]
    return lut


def _relabel(lab):
    ids = np.unique(lab)
    ids = ids[ids > 0]
    lut = np.zeros(int(lab.max()) + 1, np.int32)
    lut[ids] = np.arange(1, ids.size + 1, dtype=np.int32)
    return lut[lab], ids.size


def zone_stats(lab, n, z, slope, aspect, tree, cls, lap, band, grid, t_lo):
    idx = np.arange(1, n + 1)
    flat = lab.ravel()
    cnt = np.bincount(flat, minlength=n + 1).astype(float)
    cnt[0] = 1

    def mean(a):
        return np.bincount(flat, weights=a.ravel().astype(np.float64), minlength=n + 1) / cnt

    st = {}
    st["cells"] = cnt
    rr, cc = np.indices(lab.shape)
    st["row"] = mean(rr)
    st["col"] = mean(cc)
    st["z"] = mean(np.nan_to_num(z))
    zz = np.nan_to_num(z, nan=-1e4)
    st["zmin"] = np.r_[0, ndimage.minimum(zz, lab, idx)]
    st["zmax"] = np.r_[0, ndimage.maximum(zz, lab, idx)]
    st["slope"] = mean(slope)
    st["slope_sd"] = np.sqrt(np.maximum(mean(slope.astype(np.float64) ** 2) - st["slope"] ** 2, 0))
    for k, (lo, hi) in {"m30": (0, 30), "m35": (30, 35), "m45": (35, 45), "mx": (45, 91)}.items():
        st[k] = mean(((slope >= lo) & (slope < hi)).astype(np.float32))
    st["good"] = mean(((slope >= 25) & (slope < 40)).astype(np.float32))
    st["tree"] = mean(tree)
    st["glac"] = mean((cls == T.WC_SNOW).astype(np.float32))
    st["trap"] = mean(((lap > 0.004) & (slope > 25)).astype(np.float32))
    st["e"] = mean(np.sin(np.radians(aspect)))
    st["n"] = mean(np.cos(np.radians(aspect)))
    st["band"] = np.rint(mean(band)).astype(int)
    st["tlo"] = mean(t_lo)
    # area: cell size varies a little with latitude
    cell_km2 = (grid.dy * grid.dx_row / 1e6)
    st["area"] = np.bincount(flat, weights=np.broadcast_to(cell_km2[:, None], lab.shape).ravel(),
                             minlength=n + 1)
    return st


def potential(st):
    relief = st["zmax"] - st["zmin"]
    r = np.clip((relief - 100) / 450, 0, 1)
    size = np.clip(st["area"] / 0.8, 0, 1)
    consist = np.clip(1 - (st["slope_sd"] - 4) / 12, 0, 1)
    p = 0.35 * r + 0.35 * st["good"] + 0.15 * size + 0.15 * consist - 0.5 * st["mx"]
    return np.clip(p, 0, 1)


def polygons(lab, n, grid):
    """Outline of each zone, simplified for the web. Returns {zone_id: [[lon, lat], ...]}."""
    out = {}
    best = {}
    for geom, val in features.shapes(lab, mask=lab > 0, transform=grid.transform, connectivity=4):
        v = int(val)
        poly = shape(geom)
        a = poly.area
        if v in best and best[v] >= a:
            continue
        best[v] = a
        s = Polygon(poly.exterior).simplify(SIMPLIFY_DEG, preserve_topology=True)
        if s.is_empty or not s.is_valid:
            s = Polygon(poly.exterior)
        out[v] = [[round(x, 4), round(y, 4)] for x, y in s.exterior.coords]
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build(rid):
    region = REGIONS[rid]
    bb = region["bbox"]
    b = S.bbox_str(bb)
    t0 = time.time()
    log(f"\n=== {region['name']} ===")
    z, grid = T.load_dem(S.dem_files(region), bb)
    tree, cls = T.load_cover(S.worldcover_files(region), grid)
    slope, aspect, aspect_s, lap = T.derivatives(z, grid)
    t_lo, t_hi = T.treeline(z, slope, tree, cls, grid)
    official = official_bands(region, grid, t_lo, t_hi)
    band = T.bands(z, t_lo, t_hi)
    log(f"terrain ready ({time.time() - t0:.0f} s), grid {grid.H} x {grid.W}")

    base_ok = (slope >= MIN_SLOPE) & ~np.isnan(z) & (cls != T.WC_WATER) & (cls != 0)
    cell_km2 = float(grid.dy * np.mean(grid.dx_row) / 1e6)

    # --- automatic exclusions ---
    excl = np.zeros(grid.shape, bool)
    report = {"region": rid, "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
              "sources": [], "curated": []}
    for key, lab_, geoms in gather_exclusions(rid, region, b):
        geoms = [g for g in geoms if g is not None and not g.is_empty]
        m = features.rasterize(((g, 1) for g in geoms), out_shape=grid.shape, transform=grid.transform,
                               fill=0, dtype="uint8").astype(bool) if geoms else np.zeros(grid.shape, bool)
        km2 = float((m & base_ok & ~excl).sum() * cell_km2)
        report["sources"].append(dict(key=key, label=lab_, features=len(geoms), terrainKm2=round(km2, 1)))
        log(f"  exclude {lab_}: {len(geoms)} areas, {km2:.0f} km2 of slopes")
        excl |= m
    ridable = base_ok & ~excl

    # --- zones (curated removals applied after a first pass, so we can count them) ---
    lab, n = segment(ridable, band, aspect_s, grid)
    curated = json.loads((HERE / "exclusions" / "curated.json").read_text()).get("shapes", [])
    if curated:
        cur_mask = np.zeros(grid.shape, bool)
        for k, sh in enumerate(curated):
            g = shape(sh["geometry"]) if "geometry" in sh else Polygon(sh["coordinates"][0])
            m = features.rasterize([(g, 1)], out_shape=grid.shape, transform=grid.transform, fill=0,
                                   dtype="uint8").astype(bool)
            inside = np.bincount(lab[m], minlength=n + 1)[1:]
            tot = np.bincount(lab.ravel(), minlength=n + 1)[1:]
            dropped = int(((inside / np.maximum(tot, 1)) >= CURATED_DROP_FRAC).sum())
            report["curated"].append(dict(index=k, zonesRemoved=dropped,
                                          terrainKm2=round(float((m & ridable).sum() * cell_km2), 2)))
            cur_mask |= m
        ridable &= ~cur_mask
        lab, n = segment(ridable, band, aspect_s, grid)
    st = zone_stats(lab, n, z, slope, aspect, tree, cls, lap, band, grid, t_lo)
    relief = st["zmax"] - st["zmin"]
    log(f"zones: {n} candidates; {(relief >= MIN_RELIEF).sum() - ((relief >= MIN_RELIEF) & (st['zmax'] < st['tlo'] - BELOW_TREELINE_M)).sum()} "
        f"after the relief and low-forest filters; slopes total {base_ok.sum() * cell_km2:.0f} km2 ({time.time() - t0:.0f} s)")

    # --- coarse grids for routing and wind ---
    k = COARSE
    zc = T.coarsen(z, k, "mean")
    s35 = T.coarsen((slope >= 35).astype(np.float32), k)
    s45 = T.coarsen((slope >= 45).astype(np.float32), k)
    s30 = T.coarsen((slope >= 30).astype(np.float32), k)
    treec = T.coarsen(tree, k)
    water = T.coarsen((cls == T.WC_WATER).astype(np.float32), k)
    labc = T.coarsen(lab, k, "center")
    dy_c = grid.dy * k
    dx_c = T.coarsen(np.broadcast_to(grid.dx_row[:, None], grid.shape), k)[:, 0] * k
    ctrans = grid.transform * Affine.scale(k, k)
    # Start zones: mostly-steep cells in patches of at least ~4 ha (5 coarse cells)
    steep = s30 > 0.6
    lab_s, n_s = ndimage.label(steep)
    big = np.bincount(lab_s.ravel()) >= 5
    big[0] = False
    exposed = T.avalanche_exposure(zc, big[lab_s], dy_c, dx_c, alpha_deg=ALPHA_DEG, max_m=1200)
    # Where AutoATES has run, its map replaces the simple rule above (Steve, 2026-11-08):
    # challenging terrain or worse counts as avalanche terrain for routing and the approach flag.
    # The simple rule only fills in, for route costs, where AutoATES hasn't run yet.
    aa_fine, aa_ok = load_autoates(rid, grid)
    if aa_ok.any():
        aa_c = T.coarsen(aa_fine.astype(np.float32), k, "max")
        modelled_c = T.coarsen(aa_ok.astype(np.float32), k) > 0.5
        exposed = np.where(modelled_c, aa_c >= 2, exposed)
    log(f"AutoATES covers {100 * aa_ok.mean():.0f}% of the region so far")
    shelter = T.wind_shelter(zc, dy_c, dx_c)
    log(f"coarse grids ready ({time.time() - t0:.0f} s)")

    ka = json.loads((HERE / "known_access.json").read_text())
    plowed, sled = road_lines(region, b, ka, rid)
    cshape = zc.shape

    def rast(geoms, touched=True):
        geoms = [g for g in geoms if g is not None and not g.is_empty]
        if not geoms:
            return np.zeros(cshape, bool)
        return features.rasterize(((g, 1) for g in geoms), out_shape=cshape, transform=ctrans, fill=0,
                                  all_touched=touched, dtype="uint8").astype(bool)

    plowed_c = rast(plowed)
    no_sled = rast(no_sled_geoms(region, b), touched=False)
    sled_c = rast(sled) & ~no_sled & ~plowed_c
    # unloading spots: plowed cells next to a sled route
    sled_c |= plowed_c & ndimage.binary_dilation(sled_c, iterations=1)
    log(f"roads: {plowed_c.sum()} plowed cells, {sled_c.sum()} sled-route cells")

    factor = A.terrain_factor(s35, s45, treec, water, exposed)
    router = A.Router(zc, factor, dy_c, dx_c, sled_cells=sled_c)

    def to_cell(lat, lon):
        i, j = grid.cell(lat, lon)
        return int(np.clip(i // k, 0, cshape[0] - 1)), int(np.clip(j // k, 0, cshape[1] - 1))

    road_starts = [(int(c), 0.0) for c in np.nonzero(plowed_c.ravel())[0]]
    trailheads = [t for t in ka["trailheads"] if t["region"] == rid]
    if "US" in region["country"]:
        for f in S.us_winter_sites(b):
            p = f["properties"]
            if p.get("latitude") and "sno-park" in (p.get("recareaname") or "").lower():
                trailheads.append(dict(name=p["recareaname"], lat=float(p["latitude"]), lon=float(p["longitude"])))
    th_out, th_of_cell = [], {}   # trailheads with something to tell people (e.g. chains required)
    for t in trailheads:
        if not (bb["lat_min"] <= t["lat"] <= bb["lat_max"] and bb["lon_min"] <= t["lon"] <= bb["lon_max"]):
            continue
        i, j = to_cell(t["lat"], t["lon"])
        road_starts.append((i * cshape[1] + j, 0.0))
        if t.get("note"):
            th_of_cell[i * cshape[1] + j] = len(th_out)
            th_out.append(dict(name=t["name"], note=t["note"]))

    dist_skin, pred_skin = router.run(road_starts, use_sled=False)
    dist_sled, pred_sled = router.run(road_starts, use_sled=True)
    gates = []
    for gte in ka["liftGates"]:
        if gte["region"] != rid:
            continue
        i, j = grid.cell(gte["lat"], gte["lon"])
        r = int(1500 / grid.dy)
        win = np.nan_to_num(z[max(0, i - r):i + r, max(0, j - r):j + r], nan=-1)
        di, dj = np.unravel_index(np.argmax(win), win.shape)
        ii, jj = max(0, i - r) + di, max(0, j - r) + dj
        gates.append((gte, (ii // k) * cshape[1] + (jj // k)))
    dist_lift = pred_lift = None
    if gates:
        dist_lift, pred_lift = router.run([(c, g["rideHours"]) for g, c in gates], use_sled=False)
    log(f"routing done ({time.time() - t0:.0f} s)")

    # Target cells: the upper part of each zone on the coarse grid
    lc = labc.ravel()
    zcf = zc.ravel()
    thr = (st["z"] + st["zmax"]) / 2
    cand = np.nonzero((lc > 0) & (zcf >= thr[lc] - 1e-6))[0]
    # zones too small to own a coarse cell: use the coarse cell of their highest point
    have = np.zeros(n + 1, bool)
    have[lc[cand]] = True
    extra_z, extra_c = [], []
    if (~have[1:]).any():
        top = ndimage.maximum_position(np.nan_to_num(z, nan=-1e4), lab, np.arange(1, n + 1))
        for zid in np.nonzero(~have[1:])[0] + 1:
            i, j = top[zid - 1]
            extra_z.append(zid)
            extra_c.append((i // k) * cshape[1] + (j // k))
    cand_zone = np.r_[lc[cand], np.array(extra_z, np.int64)]
    cand_cell = np.r_[cand, np.array(extra_c, np.int64)]

    def best_target(dist):
        d = dist[cand_cell]
        order = np.lexsort((d, cand_zone))
        zs, cs, ds = cand_zone[order], cand_cell[order], d[order]
        first = np.r_[True, zs[1:] != zs[:-1]]
        bt = np.full(n + 1, -1, np.int64)
        bd = np.full(n + 1, np.inf)
        bt[zs[first]] = cs[first]
        bd[zs[first]] = ds[first]
        return bt, bd

    tgt_skin, h_skin = best_target(dist_skin)
    tgt_sled, h_sled = best_target(dist_sled)
    if dist_lift is not None:
        tgt_lift, h_lift = best_target(dist_lift)
    exp_flat = exposed.ravel()

    # --- wind loading / scouring per zone ---
    zone_cells_c = np.bincount(lc, minlength=n + 1).astype(float)
    sx = np.zeros((8, n + 1))
    for d in range(8):
        sx[d] = np.bincount(lc, weights=shelter[d].ravel(), minlength=n + 1) / np.maximum(zone_cells_c, 1)
    asp_zone = (np.degrees(np.arctan2(st["e"], st["n"])) + 360) % 360
    pot = potential(st)

    # --- names ---
    names = nearest_names(region, b)
    polys = polygons(lab, n, grid)
    log(f"polygons done ({time.time() - t0:.0f} s)")

    # --- use level from open data ---
    lat_c, lon_c = grid.latlon(st["row"], st["col"])
    use = usage(rid, region, b, lab, n, grid)
    log(f"usage done ({time.time() - t0:.0f} s)")

    # Areas to point out on zones (heli tenures, proposed resorts, flagged cultural areas)
    highlights = highlight_areas(region, b)
    blocked_cultural = [a for a in cultural_areas(region, b) if a["status"] == "block"]
    zone_tot = np.bincount(lab.ravel(), minlength=n + 1)
    zone_flags = defaultdict(list)
    for ai, a in enumerate(highlights):
        m = features.rasterize([(a["geom"], 1)], out_shape=grid.shape, transform=grid.transform, fill=0,
                               dtype="uint8").astype(bool)
        inside = np.bincount(lab[m], minlength=n + 1)
        for zid in np.nonzero(inside[1:] >= HIGHLIGHT_MIN_SHARE * zone_tot[1:])[0] + 1:
            zone_flags[int(zid)].append(ai)
    ates_f = S.bc_wfs("WHSE_HUMAN_CULTURAL_ECONOMIC.RST_ATES_RECREATION_BNDRY_SP", b, geom="GEOMETRY") \
        if "CA" in region["country"] else []
    ates = [(prep(shape(f["geometry"])), f["properties"]["ATES_RECREATION_BNDRY_NAME"]) for f in ates_f]
    permits = [(box(*p["bbox"]), i) for i, p in enumerate(ka["permitsAndClosures"]) if p["region"] == rid]

    # AutoATES class mix per zone (only where it covers at least 80% of the zone)
    flat_l = lab.ravel()
    ok_f = aa_ok.ravel()
    aa_tot = np.bincount(flat_l, minlength=n + 1)
    aa_cov = np.bincount(flat_l[ok_f], minlength=n + 1)
    aa_cnt = [np.bincount(flat_l[ok_f & (aa_fine.ravel() == c)], minlength=n + 1) for c in (1, 2, 3, 4)]

    zones = []
    dropped_far = 0
    for zid in range(1, n + 1):
        if relief[zid] < MIN_RELIEF or zid not in polys or st["zmax"][zid] < st["tlo"][zid] - BELOW_TREELINE_M:
            continue
        acc = {}
        if np.isfinite(h_skin[zid]) and h_skin[zid] <= MAX_HOURS:
            leg = router.trace(pred_skin, tgt_skin[zid], dy_c, dx_c, exp_flat, lc, zid)
            acc["skin"] = dict(h=round(float(h_skin[zid]), 1), km=round(leg["skin_km"], 1),
                               up=int(round(leg["climb"], -1)), exp=exposed_flag(leg))
            if leg["start"] in th_of_cell:
                acc["skin"]["th"] = th_of_cell[leg["start"]]
        if np.isfinite(h_sled[zid]) and h_sled[zid] <= MAX_HOURS:
            leg = router.trace(pred_sled, tgt_sled[zid], dy_c, dx_c, exp_flat, lc, zid)
            skin_h = A.skin_hours(leg["skin_km"], leg["climb"])
            if leg["sled_km"] >= 2 and h_sled[zid] < h_skin[zid] - 0.4:
                acc["sled"] = dict(h=round(float(h_sled[zid]), 1), sledKm=round(leg["sled_km"]),
                                   sledH=round(leg["sled_km"] / A.SLED_KMH, 1),
                                   km=round(leg["skin_km"], 1), up=int(round(leg["climb"], -1)),
                                   exp=exposed_flag(leg))
                if leg["start"] in th_of_cell:
                    acc["sled"]["th"] = th_of_cell[leg["start"]]
        if dist_lift is not None and np.isfinite(h_lift[zid]) and h_lift[zid] <= MAX_HOURS and \
                h_lift[zid] < h_skin[zid] - 0.5:
            leg = router.trace(pred_lift, tgt_lift[zid], dy_c, dx_c, exp_flat, lc, zid)
            gi = nearest_gate(gates, tgt_lift[zid], pred_lift, router)
            acc["lift"] = dict(h=round(float(h_lift[zid]), 1), km=round(leg["skin_km"], 1),
                               up=int(round(leg["climb"], -1)), exp=exposed_flag(leg), gate=gi)
        if not acc:
            dropped_far += 1
            continue
        best_h = min(a["h"] for a in acc.values())
        la, lo = float(lat_c[zid]), float(lon_c[zid])
        pt = Point(lo, la)
        zone = dict(
            c=[round(la, 4), round(lo, 4)],
            b=int(st["band"][zid]),
            asp=int(round(asp_zone[zid])),
            el=[int(st["zmin"][zid]), int(st["z"][zid]), int(st["zmax"][zid])],
            km2=round(float(st["area"][zid]), 2),
            mix=[int(round(100 * st[x][zid])) for x in ("m30", "m35", "m45", "mx")],
            tree=round(float(st["tree"][zid]), 2),
            glac=round(float(st["glac"][zid]), 2),
            trap=round(float(st["trap"][zid]), 2),
            pot=round(float(pot[zid]), 2),
            wl=wind_digits(asp_zone[zid], sx[:, zid], st["tree"][zid], load=True),
            ws=wind_digits(asp_zone[zid], sx[:, zid], st["tree"][zid], load=False),
            use=use["level"].get(zid, 0),
            u=use["detail"].get(zid, [0, 0, 0]),
            acc=acc,
            md=best_h > A.MULTI_DAY_H,
            p=encode_ring(polys[zid], la, lo),
        )
        nm = names(la, lo)
        if nm:
            zone["n"] = nm
        if zone_flags.get(zid):
            zone["fl"] = zone_flags[zid]
        if aa_tot[zid] and aa_cov[zid] >= 0.8 * aa_tot[zid]:
            mix = [100 * c[zid] / aa_cov[zid] for c in aa_cnt]
            zone["aa"] = [int(round(v)) for v in mix]
        else:
            for a_ in zone["acc"].values():
                a_["exp"] = None      # not assessed: AutoATES hasn't run here yet
        for p_, nm_ in ates:
            if p_.contains(pt):
                zone["ates"] = nm_
                break
        prm = [i for bx_, i in permits if bx_.contains(pt)]
        if prm:
            zone["prm"] = prm
        zones.append(zone)

    zones.sort(key=lambda zz: (-zz["c"][0], zz["c"][1]))
    prefix = "".join(w[0] for w in region["name"].upper().split())
    for i, zz in enumerate(zones):
        zz["id"] = f"{prefix}-{i + 1:04d}"

    fpoints = forecast_points(zones, t_lo, t_hi, grid)
    out = dict(
        region=rid, name=region["name"], generated=report["built"],
        sources="Copernicus GLO-30 DEM; ESA WorldCover 2021; BC Data Catalogue; US Census TIGER; USFS EDW; "
                "OpenStreetMap contributors (ohsome, GPS traces); Avalanche Canada Mountain Information Network",
        bbox=bb, centres=region["avalanche_centres"],
        settings=dict(munterUp=A.MUNTER_UP, munterDown=A.MUNTER_DOWN, sledKmh=A.SLED_KMH,
                      multiDayH=A.MULTI_DAY_H, alphaDeg=ALPHA_DEG),
        bandsNote=("Elevation bands as published by the avalanche centre: " + "; ".join(official)) if official else
                  "Elevation bands estimated from where forest gives way to open terrain (ESA WorldCover), "
                  "calibrated against the bands US avalanche centres publish.",
        forecastPoints=fpoints,
        gates=[dict(name=g["name"], resort=g["resort"], note=g["note"], url=g["url"], rideHours=g["rideHours"])
               for g, _ in gates],
        trailheads=th_out,
        permits=[p for p in ka["permitsAndClosures"] if p["region"] == rid],
        areas=[area_record(a) for a in highlights],
        closedAreas=[area_record(a) for a in blocked_cultural],
        useLabels=USE_LABELS,
        atesModel=dict(name="AutoATES v2.0", coverage=round(float(aa_ok.mean()), 3),
                       cite="Toft et al. (2024), Natural Hazards and Earth System Sciences 24, 1779-1793",
                       url="https://doi.org/10.5194/nhess-24-1779-2024",
                       note="Model estimate of avalanche terrain exposure, not an official ATES rating."),
        zones=zones,
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"zones-{rid}.json").write_text(json.dumps(out, separators=(",", ":")))
    report["zones"] = len(zones)
    report["droppedTooFar"] = dropped_far
    report["useLevels"] = dict(Counter(USE_LABELS[zz["use"]] for zz in zones))
    (HERE / "exclusions" / f"sources-{rid}.json").write_text(json.dumps(report, indent=2))
    write_known_zones(rid, region, b, zones)
    size = (OUT / f"zones-{rid}.json").stat().st_size / 1e6
    log(f"wrote {len(zones)} zones ({size:.1f} MB), {len(fpoints)} forecast points, "
        f"{dropped_far} dropped as > {MAX_HOURS} h, in {time.time() - t0:.0f} s")
    log("use levels:", report["useLevels"])
    return out


def encode_ring(ring, lat, lon):
    """Outline as whole-number steps of 0.0001 deg: [dlon, dlat, dlon, dlat, ...].

    The first step is from the zone centre, each later one from the previous point.
    (snow/js/zones.js decodes it.) Roughly a third of the size of plain coordinates.
    """
    out = []
    px, py = round(lon * 1e4), round(lat * 1e4)
    for x, y in ring[:-1]:          # the closing point repeats the first: skip it
        ix, iy = round(x * 1e4), round(y * 1e4)
        out += [ix - px, iy - py]
        px, py = ix, iy
    return out


def load_autoates(rid, grid):
    """AutoATES tiles for a region on the zone grid: (classes 1-4, mask of where it has run)."""
    cls = np.zeros(grid.shape, np.int8)
    ok = np.zeros(grid.shape, bool)
    for path in sorted((HERE / "cache" / "autoates" / rid).glob("tile_*.tif")):
        with rasterio.open(path) as s:
            a = s.read(1)
            dst = np.full(grid.shape, -1, np.int16)
            # inside a modelled tile, "no class" means no avalanche terrain found: count it as simple
            reproject(np.where(a == -9999, 1, a).astype(np.int16), dst, src_transform=s.transform, src_crs=s.crs,
                      dst_transform=grid.transform, dst_crs="EPSG:4326", resampling=Resampling.nearest,
                      src_nodata=-1, dst_nodata=-1)
        m = dst >= 1
        cls[m] = dst[m]
        ok |= m
    return cls, ok


def exposed_flag(leg):
    """Flag an approach that spends a real stretch (~360 m or more) on or under avalanche terrain."""
    return bool(leg["max_exposed_run"] >= 4 or leg["exposed_cells"] >= 8)


def nearest_gate(gates, target, pred, router):
    node = target
    while True:
        p = pred[node]
        if p < 0 or p == router.S:
            break
        node = p
    for i, (_, c) in enumerate(gates):
        if c == node:
            return i
    return 0


def wind_digits(aspect, sx, tree, load=True):
    """8 digits (wind FROM N, NE, ... NW), 0-9: how strongly that wind loads / scours the zone."""
    out = []
    shelter_ = 1 - 0.65 * float(tree)
    for d in range(8):
        wind_from = d * 45
        if load:
            facing = math.cos(math.radians(aspect - (wind_from + 180)))     # faces downwind = lee
            v = max(0.0, facing) * (0.55 + 0.45 * (sx[d] > 0.05)) * shelter_
        else:
            facing = math.cos(math.radians(aspect - wind_from))              # faces into the wind
            v = max(0.0, facing) * (1.0 if sx[d] < 0 else 0.35) * (1 - 0.75 * float(tree))
        out.append(str(min(9, int(round(v * 9)))))
    return "".join(out)


def forecast_points(zones, t_lo, t_hi, grid):
    """Group zones onto a coarse grid; each point is forecast at 3 elevations (one per band)."""
    deg = 0.08
    while True:
        cells = defaultdict(list)
        for zz in zones:
            cells[(round(zz["c"][0] / deg), round(zz["c"][1] / deg))].append(zz)
        if len(cells) <= MAX_FP:
            break
        deg += 0.01
    fps = []
    for fi, (_, members) in enumerate(sorted(cells.items())):
        la = float(np.mean([m["c"][0] for m in members]))
        lo = float(np.mean([m["c"][1] for m in members]))
        i, j = grid.cell(la, lo)
        i, j = int(np.clip(i, 0, grid.H - 1)), int(np.clip(j, 0, grid.W - 1))
        tl, th = float(t_lo[i, j]), float(t_hi[i, j])
        elevs = [int(max(300, tl - 250)), int((tl + th) / 2), int(th + 300)]
        fps.append(dict(lat=round(la, 3), lon=round(lo, 3), el=elevs, tl=[int(tl), int(th)]))
        for m in members:
            m["fp"] = fi
    return fps


def nearest_names(region, b):
    """A function (lat, lon) -> 'Near <peak>' using official BC geographic names."""
    if "CA" not in region["country"]:
        return lambda la, lo: None
    fs = S.bc_wfs("WHSE_BASEMAPPING.GNS_GEOGRAPHICAL_NAMES_SP", b, geom="GEOMETRY",
                  props=["GEOGRAPHICAL_NAME", "FEATURE_TYPE", "LATITUDE", "LONGITUDE"])
    keep = ("Mountain", "Mount", "Peak", "Summit", "Ridge", "Glacier", "Pass", "Peaks", "Pinnacle", "Range",
            "Col", "Icefield", "Spire", "Bluff", "Butte", "Hill", "Dome", "Cirque", "Basin", "Meadow")
    pts = [(f["properties"]["LATITUDE"], f["properties"]["LONGITUDE"], f["properties"]["GEOGRAPHICAL_NAME"])
           for f in fs if any(f["properties"]["FEATURE_TYPE"].startswith(k) for k in keep)]
    if not pts:
        return lambda la, lo: None
    arr = np.array([(p[0], p[1]) for p in pts])

    def f(la, lo):
        d = np.hypot(arr[:, 0] - la, (arr[:, 1] - lo) * math.cos(math.radians(la))) * 111
        i = int(np.argmin(d))
        return pts[i][2] if d[i] <= 3.0 else None

    return f


def usage(rid, region, b, lab, n, grid):
    """How much each zone is travelled, from aggregated open data only."""
    def window_labels(lats, lons, r):
        i, j = grid.cell(np.asarray(lats), np.asarray(lons))
        ok = grid.inside(i, j)
        i, j = i[ok], j[ok]
        offs = np.arange(-r, r + 1)
        ii = np.clip(i[:, None, None] + offs[None, :, None], 0, grid.H - 1)
        jj = np.clip(j[:, None, None] + offs[None, None, :], 0, grid.W - 1)
        return lab[ii, jj].reshape(len(i), -1), ok

    # Mountain Information Network reports within ~300 m
    mins = S.min_locations(b)
    min_n = np.zeros(n + 1, int)
    if mins:
        arr = np.array([(m[0], m[1]) for m in mins])
        for s in range(0, len(arr), 2000):
            w, _ = window_labels(arr[s:s + 2000, 0], arr[s:s + 2000, 1], 10)
            for row in w:
                u = np.unique(row)
                min_n[u[u > 0]] += 1
    # Winter GPS traces within ~60 m (count distinct traces, not points)
    gps = S.gps_winter_points(b)
    gps_n = np.zeros(n + 1, int)
    if gps:
        arr = np.array(gps, dtype=np.float64)
        pairs = set()
        for s in range(0, len(arr), 20000):
            w, ok = window_labels(arr[s:s + 20000, 0], arr[s:s + 20000, 1], 2)
            tids = arr[s:s + 20000, 2][ok].astype(np.int64)
            for t, row in zip(tids, w):
                for zz in np.unique(row):
                    if zz > 0:
                        pairs.add((int(zz), int(t)))
        for zz, _ in pairs:
            gps_n[zz] += 1
    # Mapped ski-touring routes (OpenStreetMap): metres of route in 500 m squares,
    # credited to every zone that covers a good part of the square
    cells, complete = S.ohsome_route_grid(b)
    route_m = np.zeros(n + 1)
    for lon0, lat0, lon1, lat1, metres in cells:
        i1, j0 = grid.cell(lat0, lon0)
        i0, j1 = grid.cell(lat1, lon1)
        i0, i1 = max(0, int(i0)), min(grid.H, int(i1) + 1)
        j0, j1 = max(0, int(j0)), min(grid.W, int(j1) + 1)
        if i0 >= i1 or j0 >= j1:
            continue
        sub = lab[i0:i1, j0:j1]
        cnt = np.bincount(sub.ravel(), minlength=n + 1)
        share = cnt / sub.size
        hit = np.nonzero(share >= 0.15)[0]
        hit = hit[hit > 0]
        route_m[hit] += metres
    if not complete:
        log("  WARNING: ski-route data incomplete (ohsome unavailable); use levels may be too low")
    level, detail = {}, {}
    for zid in range(1, n + 1):
        r_, m_, g_ = route_m[zid], min_n[zid], gps_n[zid]
        if r_ >= 300 or m_ >= 4 or g_ >= 4 or (r_ > 0 and (m_ >= 2 or g_ >= 2)):
            lv = 2
        elif r_ > 0 or m_ >= 1 or g_ >= 1:
            lv = 1
        else:
            lv = 0
        level[zid] = lv
        detail[zid] = [int(round(r_)), int(m_), int(g_)]
    return dict(level=level, detail=detail)


STOP = re.compile(r"\b(obs|observation|observations|report|conditions|tour|trip|ski|skiing|day|am|pm|"
                  r"today|quick|update|snowpack|avalanche|avy|field|weekend|morning|afternoon|"
                  r"jan|feb|mar|apr|may|nov|dec|\d+)\b")


# Titles about people, courses or events rather than places
NOT_PLACE = re.compile(r"\b(ast|course|exercise|class|group|crew|shreds|damage|assessment|lightning|"
                       r"rescue|incident|accident|test|practice|my|our|we)\b")


def write_known_zones(rid, region, b, zones):
    """Suggest named, known zones from places that several MIN reports name."""
    titles = S.min_titles(b)
    groups = defaultdict(list)
    for la, lo, t in titles:
        key = STOP.sub(" ", re.sub(r"[^a-z0-9' ]", " ", t.lower()))
        key = " ".join(key.split())
        if len(key) >= 4 and not NOT_PLACE.search(key):
            groups[key].append((la, lo))
    path = HERE / "known_zones.json"
    data = json.loads(path.read_text()) if path.exists() else {"_about": "", "zones": {}}
    data["_about"] = ("Named places that several Mountain Information Network reports mention, with the "
                      "number of reports. A starting list for Steve to check: rename, merge or delete freely. "
                      "Only place names are kept, never who wrote the reports.")
    out = []
    for key, pts in groups.items():
        if len(pts) < 3:
            continue
        a = np.array(pts)
        la, lo = float(np.median(a[:, 0])), float(np.median(a[:, 1]))
        spread = float(np.median(np.hypot(a[:, 0] - la, (a[:, 1] - lo) * 0.64)) * 111)
        if spread > 5:
            continue  # same words used all over the region: not one place
        out.append(dict(name=key.title(), lat=round(la, 3), lon=round(lo, 3), reports=len(pts)))
    out.sort(key=lambda x: -x["reports"])
    data["zones"][rid] = out[:150]
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False))


def write_index():
    idx = []
    for rid, r in REGIONS.items():
        p = OUT / f"zones-{rid}.json"
        if p.exists():
            d = json.loads(p.read_text())
            idx.append(dict(id=rid, name=r["name"], bbox=r["bbox"], zones=len(d["zones"]),
                            centres=r["avalanche_centres"], generated=d["generated"]))
    (OUT / "regions.json").write_text(json.dumps(dict(regions=idx), indent=1))


if __name__ == "__main__":
    for rid in (sys.argv[1:] or list(REGIONS)):
        build(rid)
    write_index()
