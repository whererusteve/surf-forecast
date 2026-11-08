"""Minimal stand-in for the three GDAL calls AutoATES v2.0 makes, built on rasterio/numpy."""
import numpy as np
import rasterio
from rasterio.features import sieve

TermProgress_nocb = None


class _Band:
    def __init__(self, ds):
        self.ds = ds


class _Dataset:
    def __init__(self, path, mode=0):
        self.path, self.mode = path, mode
        with rasterio.open(path) as src:
            t = src.transform
            self._gt = (t.c, t.a, t.b, t.f, t.d, t.e)

    def GetGeoTransform(self):
        return self._gt

    def GetRasterBand(self, i):
        return _Band(self)


def Open(path, mode=0):
    return _Dataset(path, mode)


def SieveFilter(srcBand, maskBand, dstBand, threshold, connectedness=8, callback=None):
    path = dstBand.ds.path
    with rasterio.open(path) as src:
        a = src.read(1)
        prof = src.profile
    out = sieve(a.astype(np.int32), size=int(threshold), connectivity=8 if connectedness == 8 else 4)
    with rasterio.open(path, "w", **prof) as dst:
        dst.write(out.astype(prof["dtype"]), 1)
    return 0


def DEMProcessing(dest, src_path, kind, **kw):
    assert kind == "slope"
    with rasterio.open(src_path) as src:
        z = src.read(1).astype(np.float64)
        prof = src.profile
        dx, dy = src.transform.a, -src.transform.e
    nod = z < -1000
    z[nod] = np.nan
    gy, gx = np.gradient(z, dy, dx)
    s = np.degrees(np.arctan(np.hypot(gx, gy)))
    s[np.isnan(s)] = -9999
    prof.update(dtype="float32", nodata=-9999)
    with rasterio.open(dest, "w", **prof) as dst:
        dst.write(s.astype(np.float32), 1)
