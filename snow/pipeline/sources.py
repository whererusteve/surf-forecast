"""
Downloads for the Snow Finder pipeline. Every download is cached in
snow/pipeline/cache/ (git-ignored), so a rebuild only fetches what is missing.

Privacy: Mountain Information Network reports and OpenStreetMap GPS traces are
reduced to bare locations (and dates) as soon as they arrive. Names, user IDs,
titles and trace links are never written to the cache or the app's data.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
UA = "snow-finder-pipeline/0.1 (non-commercial; github.com/whererusteve/surf-forecast)"


def _cache_path(kind, key, ext="json"):
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    p = CACHE / kind / f"{h}.{ext}"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def http(url, data=None, timeout=180, tries=4, headers=None):
    """GET (or POST form `data`) with retries. Returns bytes."""
    body = urllib.parse.urlencode(data).encode() if isinstance(data, dict) else data
    hdrs = {"User-Agent": UA}
    if headers:
        hdrs.update(headers)
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as err:  # network hiccup, rate limit, server busy
            if attempt == tries:
                raise RuntimeError(f"{url[:120]}... failed: {err}") from err
            time.sleep(3 * attempt)


def cached_json(kind, key, fetch):
    p = _cache_path(kind, key)
    if p.exists():
        return json.loads(p.read_text())
    data = fetch()
    p.write_text(json.dumps(data))
    return data


# ---------------------------------------------------------------------------
# Terrain rasters
# ---------------------------------------------------------------------------

def dem_files(region):
    out = []
    for t in region["dem_tiles"]:
        n = f"Copernicus_DSM_COG_10_{t}_00_DEM"
        p = CACHE / "dem" / f"{n}.tif"
        if not p.exists() or p.stat().st_size < 10_000:
            p.parent.mkdir(parents=True, exist_ok=True)
            print(f"  downloading {n} ...")
            p.write_bytes(http(f"https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif", timeout=900))
        out.append(p)
    return out


def worldcover_files(region):
    out = []
    for t in region["worldcover_tiles"]:
        f = f"ESA_WorldCover_10m_2021_v200_{t}_Map.tif"
        p = CACHE / "worldcover" / f
        if not p.exists() or p.stat().st_size < 10_000:
            p.parent.mkdir(parents=True, exist_ok=True)
            print(f"  downloading {f} ...")
            p.write_bytes(http("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/" + f,
                               timeout=1800))
        out.append(p)
    return out


# ---------------------------------------------------------------------------
# Vector data services
# ---------------------------------------------------------------------------

def bbox_str(b, pad=0.0):
    return (b["lon_min"] - pad, b["lat_min"] - pad, b["lon_max"] + pad, b["lat_max"] + pad)


def bc_wfs(layer, bbox, cql_extra=None, geom="SHAPE", props=None):
    """BC Data Catalogue (DataBC) WFS layer clipped to a bbox, as GeoJSON features."""
    x0, y0, x1, y1 = bbox
    cql = f"BBOX({geom},{x0},{y0},{x1},{y1},'EPSG:4326')"
    if cql_extra:
        cql += f" AND ({cql_extra})"
    key = f"{layer}|{cql}|{props}"

    def fetch():
        feats, start = [], 0
        while True:
            q = dict(service="WFS", version="2.0.0", request="GetFeature", typeName=f"pub:{layer}",
                     outputFormat="json", srsName="EPSG:4326", count=5000, startIndex=start,
                     CQL_FILTER=cql, sortBy="OBJECTID")
            if props:
                q["propertyName"] = ",".join(props + [geom])
            d = json.loads(http("https://openmaps.gov.bc.ca/geo/pub/wfs?" + urllib.parse.urlencode(q)))
            feats += d["features"]
            if len(d["features"]) < 5000:
                return feats
            start += 5000

    return cached_json("bcwfs", key, fetch)


def arcgis_query(service_url, bbox, where="1=1", fields="*"):
    """ArcGIS REST layer query (Census TIGERweb, Forest Service EDW) as GeoJSON features."""
    x0, y0, x1, y1 = bbox
    key = f"{service_url}|{bbox}|{where}|{fields}"

    def fetch():
        feats, offset = [], 0
        while True:
            q = dict(where=where, geometry=f"{x0},{y0},{x1},{y1}", geometryType="esriGeometryEnvelope",
                     inSR=4326, outSR=4326, spatialRel="esriSpatialRelIntersects", outFields=fields,
                     returnGeometry="true", f="geojson", resultOffset=offset, resultRecordCount=1000)
            d = json.loads(http(service_url + "/query?" + urllib.parse.urlencode(q)))
            got = d.get("features", [])
            feats += got
            if not got or not d.get("properties", {}).get("exceededTransferLimit") and len(got) < 1000:
                return feats
            offset += len(got)

    return cached_json("arcgis", key, fetch)


TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb"
EDW = "https://apps.fs.usda.gov/arcx/rest/services/EDW"


def us_tribal_lands(bbox):
    feats = []
    for layer, kind in ((2, "Federal American Indian Reservation"), (3, "Off-Reservation Trust Land")):
        for f in arcgis_query(f"{TIGER}/AIANNHA/MapServer/{layer}", bbox, fields="NAME"):
            f["properties"]["kind"] = kind
            feats.append(f)
    return feats


def us_roads(bbox):
    """Census primary + secondary roads (assumed plowed in winter)."""
    feats = []
    for layer in (2, 6):
        feats += arcgis_query(f"{TIGER}/Transportation/MapServer/{layer}", bbox, fields="NAME,MTFCC")
    return feats


def us_wilderness(bbox):
    return arcgis_query(f"{EDW}/EDW_Wilderness_02/MapServer/0", bbox, fields="WILDERNESSNAME")


def us_snowmobile_trails(bbox):
    """Forest Service trails managed for or open to snowmobiles (legal over-snow routes)."""
    where = "snowmobile_managed IS NOT NULL OR snowmobile_accpt IS NOT NULL OR snowmobile_accpt_disc IS NOT NULL"
    return arcgis_query(f"{EDW}/EDW_TrailNFSPublish_01/MapServer/0", bbox, where=where,
                        fields="trail_name,trail_no,snowmobile_managed,snowmobile_accpt")


def us_fs_roads(bbox):
    return arcgis_query(f"{EDW}/EDW_RoadBasic_01/MapServer/0", bbox, fields="NAME,ID,OPER_MAINT_LEVEL")


def us_winter_sites(bbox):
    """Forest Service recreation sites with winter activities (Sno-Parks, ski areas, ski routes)."""
    x0, y0, x1, y1 = bbox
    acts = ("Snowmobiling", "XC Skiing/Snowshoeing", "Skiing/Snowboarding")
    where = "activityname IN (" + ",".join(f"'{a}'" for a in acts) + ")"
    feats = arcgis_query(f"{EDW}/EDW_RecreationAreaActivities_01/MapServer/0", bbox, where=where,
                         fields="recareaname,activityname,recareaurl,latitude,longitude")
    return feats


# ---------------------------------------------------------------------------
# Avalanche forecast regions
# ---------------------------------------------------------------------------

def avcan_areas():
    return cached_json("avalanche", "avcan-areas",
                       lambda: json.loads(http("https://api.avalanche.ca/forecasts/en/areas")))


def avcan_metadata():
    return cached_json("avalanche", "avcan-metadata",
                       lambda: json.loads(http("https://api.avalanche.ca/forecasts/en/metadata")))


def aorg_zones():
    return cached_json("avalanche", "aorg-map-layer",
                       lambda: json.loads(http("https://api.avalanche.org/v2/public/products/map-layer")))


# ---------------------------------------------------------------------------
# Where people go (usage signals). Only locations are kept.
# ---------------------------------------------------------------------------

def _min_month(bbox, year, month):
    """One month of Mountain Information Network reports: [[lat, lon, date, title], ...].

    Usernames and user IDs are dropped here. Titles (free text) are kept only in
    the local, git-ignored cache, to suggest place names for known_zones.json.
    """
    import calendar
    x0, y0, x1, y1 = bbox
    last = calendar.monthrange(year, month)[1]
    a, b = f"{year}-{month:02d}-01", f"{year}-{month:02d}-{last}"
    key = f"min-month|{bbox}|{a}"

    def fetch():
        q = dict(fromdate=a, todate=b, bbox=f"{x0},{y0},{x1},{y1}")
        d = json.loads(http("https://api.avalanche.ca/min/submissions?" + urllib.parse.urlencode(q)))
        return [[round(i["location"]["latitude"], 4), round(i["location"]["longitude"], 4),
                 (i.get("submissionDatetime") or "")[:10], (i.get("title") or "").strip()[:60]]
                for i in d.get("items", []) if i.get("location")]

    return cached_json("min", key, fetch)


def _min_all(bbox, seasons):
    rows = []
    for s in seasons:
        for (y, m) in [(s, 11), (s, 12)] + [(s + 1, k) for k in range(1, 6)]:
            rows += _min_month(bbox, y, m)
    return rows


def min_locations(bbox, seasons=(2021, 2022, 2023, 2024, 2025)):
    """Mountain Information Network report locations, Nov-May: [[lat, lon, date], ...]."""
    return [r[:3] for r in _min_all(bbox, seasons)]


def min_titles(bbox, seasons=(2021, 2022, 2023, 2024, 2025)):
    """[[lat, lon, title], ...], used only to suggest names for known_zones.json."""
    return [[r[0], r[1], r[3]] for r in _min_all(bbox, seasons) if r[3]]


WINTER_MONTHS = {11, 12, 1, 2, 3, 4, 5}


def gps_winter_points(bbox, max_pages=12):
    """Public OpenStreetMap GPS trace points recorded in winter months.

    The API serves points in boxes of at most 0.25 deg, 5,000 per page. Traces with
    timestamps come first; untimestamped (anonymised) points come after and are
    skipped, since we can't tell winter from summer. Returns
    [[lat, lon, trace_index], ...]; trace_index only lets us count distinct traces
    per zone and isn't linked to any user.
    """
    x0, y0, x1, y1 = bbox
    pts = []
    trace_ids = {}
    step = 0.25
    for lat in np.arange(y0, y1, step):
        for lon in np.arange(x0, x1, step):
            box = (round(lon, 3), round(lat, 3), round(min(lon + step, x1), 3), round(min(lat + step, y1), 3))
            key = f"gps|{box}|{max_pages}"

            def fetch(box=box):
                got = []
                for page in range(max_pages):
                    url = ("https://api.openstreetmap.org/api/0.6/trackpoints?bbox="
                           f"{box[0]},{box[1]},{box[2]},{box[3]}&page={page}")
                    root = ET.fromstring(http(url, timeout=120))
                    time.sleep(1.0)  # be polite to the OSM servers
                    ns = {"g": "http://www.topografix.com/GPX/1/0"}
                    n_pts, untimed = 0, False
                    for trk in root.findall("g:trk", ns):
                        u = trk.find("g:url", ns)
                        tid = hashlib.sha1((u.text if u is not None else "").encode()).hexdigest()[:10] if u is not None else None
                        for p in trk.iter("{http://www.topografix.com/GPX/1/0}trkpt"):
                            n_pts += 1
                            t = p.find("g:time", ns)
                            if t is None or tid is None:
                                untimed = True
                                continue
                            month = int(t.text[5:7])
                            if month in WINTER_MONTHS:
                                got.append([round(float(p.get("lat")), 5), round(float(p.get("lon")), 5), tid])
                    if n_pts < 5000 or untimed:
                        break
                return got

            for la, lo, tid in cached_json("gps", key, fetch):
                pts.append([la, lo, trace_ids.setdefault(tid, len(trace_ids))])
    return pts


def ohsome_route_length(polygons, filt="piste:type=skitour or route=ski"):
    """Metres of mapped ski-touring route inside each polygon (OSM data via ohsome).

    `polygons` is a list of (id, [[lon, lat], ...]) outer rings. Results are cached
    per polygon shape, so a rebuild only asks about zones whose outline changed.
    A batch the server rejects is split in half and retried; a single polygon it
    still can't handle counts as 0 m (and is reported).
    """
    store_p = CACHE / "ohsome" / ("lengths-" + hashlib.sha1(filt.encode()).hexdigest()[:8] + ".json")
    store_p.parent.mkdir(parents=True, exist_ok=True)
    store = json.loads(store_p.read_text()) if store_p.exists() else {}
    keyed = [(pid, ring, hashlib.sha1(json.dumps(ring).encode()).hexdigest()[:20]) for pid, ring in polygons]
    todo = [(h, ring) for _, ring, h in keyed if h not in store]
    failed = []

    def query(chunk):
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": h, "properties": {"id": h},
             "geometry": {"type": "Polygon", "coordinates": [ring]}} for h, ring in chunk]}
        try:
            d = json.loads(http("https://api.ohsome.org/v1/elements/length/groupBy/boundary",
                                data={"bpolys": json.dumps(fc), "filter": filt}, timeout=600, tries=2))
        except RuntimeError:
            if len(chunk) == 1:
                failed.append(chunk[0][0])
                return {chunk[0][0]: 0.0}
            m = len(chunk) // 2
            return {**query(chunk[:m]), **query(chunk[m:])}
        return {g["groupByObject"]: g["result"][-1]["value"] for g in d["groupByResult"]}

    batch = 150
    for i in range(0, len(todo), batch):
        store.update(query(todo[i:i + batch]))
        store_p.write_text(json.dumps(store))
        print(f"    ski-route lengths: {min(i + batch, len(todo))}/{len(todo)} new shapes", flush=True)
    if failed:
        print(f"    ohsome could not measure {len(failed)} zones (counted as 0 m)")
    return {pid: store[h] for pid, _, h in keyed}


def osm_winter_sports_areas(bbox):
    """Ski resort boundaries (landuse=winter_sports) from the OSM API, for a small bbox.

    Used for US resorts, where no official boundary layer was found. The OSM API
    serves at most 0.25 square degrees, so call this only around known resorts.
    """
    x0, y0, x1, y1 = bbox
    key = f"osm-ws|{bbox}"

    def fetch():
        root = ET.fromstring(http(f"https://api.openstreetmap.org/api/0.6/map?bbox={x0},{y0},{x1},{y1}"))
        nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat"))) for n in root.iter("node")}
        ways = {w.get("id"): w for w in root.iter("way")}
        polys = []

        def tags(el):
            return {t.get("k"): t.get("v") for t in el.findall("tag")}

        for w in ways.values():
            tg = tags(w)
            if tg.get("landuse") == "winter_sports":
                ring = [nodes[nd.get("ref")] for nd in w.findall("nd") if nd.get("ref") in nodes]
                if len(ring) >= 4:
                    polys.append({"name": tg.get("name"), "ring": ring})
        for r in root.iter("relation"):
            tg = tags(r)
            if tg.get("landuse") == "winter_sports":
                full = ET.fromstring(http(f"https://api.openstreetmap.org/api/0.6/relation/{r.get('id')}/full"))
                fn = {n.get("id"): (float(n.get("lon")), float(n.get("lat"))) for n in full.iter("node")}
                fw = {w.get("id"): [fn[nd.get("ref")] for nd in w.findall("nd")] for w in full.iter("way")}
                outers = [fw[m.get("ref")] for m in r.findall("member")
                          if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("ref") in fw]
                for ring in _join_rings(outers):
                    polys.append({"name": tg.get("name"), "ring": ring})
        return polys

    return cached_json("osm", key, fetch)


def _join_rings(segments):
    """Join way segments of a multipolygon relation into closed rings."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings
