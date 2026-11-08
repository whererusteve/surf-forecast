"""Compare AutoATES v2.0 classes with the Snow Finder's own 'exposed to avalanche terrain' map
on the Spearhead test area. Writes coloured PNG overlays and prints agreement numbers."""
from pathlib import Path
import json, sys, numpy as np, rasterio
from affine import Affine
from rasterio.warp import reproject, Resampling
from rasterio import features
from scipy import ndimage
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "js"))
from regions import REGIONS
import sources as S, terrain as T
RUN = str(Path(__file__).resolve().parent)
BB = dict(lat_min=49.99, lat_max=50.13, lon_min=-122.93, lon_max=-122.72)
r = REGIONS["sea-to-sky"]

# --- Our exposure map, exactly as the pipeline builds it (90 m grid) ---
z, g = T.load_dem(S.dem_files(r), BB)
slope, *_ = T.derivatives(z, g)
k = 3
zc = T.coarsen(z, k, "mean")
s30 = T.coarsen((slope >= 30).astype(np.float32), k)
dy_c = g.dy * k
dx_c = T.coarsen(np.broadcast_to(g.dx_row[:, None], g.shape), k)[:, 0] * k
steep = s30 > 0.6
lab, _ = ndimage.label(steep)
big = np.bincount(lab.ravel()) >= 5; big[0] = False
ours = T.avalanche_exposure(zc, big[lab], dy_c, dx_c, alpha_deg=25, max_m=1200)
ctrans = g.transform * Affine.scale(k, k)

# --- AutoATES classes onto the same grid (worst class in each 90 m cell) ---
with rasterio.open(RUN + "/work/outputs/ates_gen.tif") as src:
    a = src.read(1)
    ates = np.full(ours.shape, -9999, np.int16)
    reproject(a, ates, src_transform=src.transform, src_crs=src.crs, dst_transform=ctrans, dst_crs="EPSG:4326",
              resampling=Resampling.max, src_nodata=-9999, dst_nodata=-9999)
ates = np.where(ates < 0, 0, ates)          # 0 = no avalanche terrain found
valid = ~np.isnan(zc)
names = {0: "none found", 1: "simple", 2: "challenging", 3: "complex", 4: "extreme"}
print("cells:", int(valid.sum()))
print("AutoATES share:", {names[c]: f"{100 * ((ates == c) & valid).sum() / valid.sum():.0f}%" for c in range(5)})
print(f"ours flags {100 * (ours & valid).sum() / valid.sum():.0f}% of the area as exposed")
for c in range(5):
    m = (ates == c) & valid
    if m.sum():
        print(f"  of AutoATES '{names[c]}' cells, ours flags {100 * (ours & m).sum() / m.sum():.0f}%")
hi = (ates >= 2) & valid
print(f"AutoATES challenging+ cells caught by ours: {100 * (ours & hi).sum() / max(hi.sum(), 1):.0f}%")
print(f"our exposed cells that AutoATES calls simple or none: {100 * (ours & ~hi & valid).sum() / max((ours & valid).sum(), 1):.0f}%")

# --- Per zone: AutoATES class mix vs our slope mix ---
import subprocess
d = json.load(open(str(Path(__file__).resolve().parents[3] / "data" / "zones-sea-to-sky.json")))
def ring(zz):
    x, y = round(zz["c"][1] * 1e4), round(zz["c"][0] * 1e4); pts = []
    for i in range(0, len(zz["p"]), 2):
        x += zz["p"][i]; y += zz["p"][i + 1]; pts.append((x / 1e4, y / 1e4))
    return {"type": "Polygon", "coordinates": [pts + [pts[0]]]}
inbox = [zz for zz in d["zones"] if BB["lat_min"] < zz["c"][0] < BB["lat_max"] and BB["lon_min"] < zz["c"][1] < BB["lon_max"]]
zl = features.rasterize(((ring(zz), i + 1) for i, zz in enumerate(inbox)), out_shape=ours.shape, transform=ctrans, fill=0, dtype="int32")
rows = []
for i, zz in enumerate(inbox):
    m = zl == i + 1
    if m.sum() < 3: continue
    mix = [int(round(100 * (ates[m] == c).mean())) for c in range(5)]
    steep_ours = zz["mix"][2] + zz["mix"][3]
    exp_flag = any(a_["exp"] for a_ in zz["acc"].values())
    rows.append((zz.get("n") or "-", zz["asp"], zz["b"], steep_ours, mix, exp_flag, zz["use"]))
json.dump(rows, open(RUN + "/zone_compare.json", "w"))
# dominant AutoATES class vs our steep share
from collections import Counter
dom = Counter()
for n, asp, b, st, mix, ef, use in rows:
    c = int(np.argmax(mix)); dom[(names[c], "steep>=45%" if st >= 45 else "steep<45%")] += 1
print("zones by dominant AutoATES class and our steep share:", dict(dom))

# --- Coloured overlays for the map (geographic, 90 m) ---
def png(arr_rgba, path):
    h, w = arr_rgba.shape[1:]
    with rasterio.open(path, "w", driver="PNG", width=w, height=h, count=4, dtype="uint8") as dst:
        dst.write(arr_rgba)
pal = {1: (102, 194, 165), 2: (65, 105, 225), 3: (20, 20, 20), 4: (200, 0, 0)}
rgba = np.zeros((4,) + ates.shape, np.uint8)
for c, col in pal.items():
    m = ates == c
    for ch in range(3): rgba[ch][m] = col[ch]
    rgba[3][m] = 150
png(rgba, RUN + "/ates.png")
rgba = np.zeros((4,) + ours.shape, np.uint8)
rgba[0][ours], rgba[1][ours], rgba[2][ours], rgba[3][ours] = 230, 85, 13, 150
png(rgba, RUN + "/ours.png")
b = rasterio.transform.array_bounds(ours.shape[0], ours.shape[1], ctrans)
json.dump({"south": b[1], "west": b[0], "north": b[3], "east": b[2]}, open(RUN + "/bounds.json", "w"))
print("overlays written")
