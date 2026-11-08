"""Spearhead test area: DEM and percent canopy cover on a 30 m UTM grid (EPSG:32610)."""
from pathlib import Path
import sys, numpy as np, rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from regions import REGIONS
import sources as S, terrain as T
BB = dict(lat_min=49.99, lat_max=50.13, lon_min=-122.93, lon_max=-122.72)
r = REGIONS["sea-to-sky"]
z, g = T.load_dem(S.dem_files(r), BB)
tree, cls = T.load_cover(S.worldcover_files(r), g)
x0, y0, x1, y1 = transform_bounds("EPSG:4326", "EPSG:32610", BB["lon_min"], BB["lat_min"], BB["lon_max"], BB["lat_max"])
res = 30.0
W, H = int((x1 - x0) // res), int((y1 - y0) // res)
dst_t = from_origin(x0, y1, res, res)
out_z = np.full((H, W), -9999, np.float32); out_f = np.zeros((H, W), np.float32)
reproject(np.nan_to_num(z, nan=-9999), out_z, src_transform=g.transform, src_crs="EPSG:4326", dst_transform=dst_t, dst_crs="EPSG:32610", resampling=Resampling.bilinear, src_nodata=-9999, dst_nodata=-9999)
reproject(tree * 100, out_f, src_transform=g.transform, src_crs="EPSG:4326", dst_transform=dst_t, dst_crs="EPSG:32610", resampling=Resampling.bilinear)
prof = dict(driver="GTiff", width=W, height=H, count=1, crs="EPSG:32610", transform=dst_t)
with rasterio.open("work/PRA/DEM.tif", "w", dtype="int16", nodata=-9999, **prof) as d: d.write(np.round(out_z).astype("int16"), 1)
with rasterio.open("work/PRA/FOREST.tif", "w", dtype="int16", nodata=-9999, **prof) as d: d.write(np.round(out_f).astype("int16"), 1)
print("grid", H, W, "cells", H * W)
