"""Final AutoATES step: prepare Flow-Py outputs the way the classifier expects, then run it unchanged
except for the input paths and forest type (pcc = percent canopy cover)."""
from pathlib import Path
import glob, os, re, subprocess, sys, numpy as np, rasterio
RUN = os.path.dirname(os.path.abspath(__file__))
W = RUN + "/work"
res = sorted(glob.glob(W + "/res_*/"))[-1]
os.makedirs(W + "/inputs", exist_ok=True); os.makedirs(W + "/outputs", exist_ok=True)

def to_int16(src, dst):
    with rasterio.open(src) as s:
        a = s.read(1); p = s.profile
    a = np.where(a > 0, np.round(a), -9999).astype("int16")     # not reached by any avalanche path -> nodata
    p.update(dtype="int16", nodata=-9999)
    with rasterio.open(dst, "w", **p) as d:
        d.write(a, 1)

to_int16(res + "FP_travel_angle.tif", W + "/inputs/FP_int16.tif")
to_int16(res + "cell_counts.tif", W + "/inputs/Overhead.tif")
code = open(RUN + "/src/AutoATES_classifier.py").read()
subs = {"DEM": W + "/PRA/DEM.tif", "canopy": W + "/PRA/FOREST.tif", "cell_count": W + "/inputs/Overhead.tif",
        "FP": W + "/inputs/FP_int16.tif", "SZ": W + "/PRA/PRA_binary.tif", "forest_type": "pcc", "wd": W + "/outputs"}
for k, v in subs.items():
    code, n = re.subn(rf"^{k} = .*$", f"{k} = {v!r}", code, count=1, flags=re.M)
    assert n == 1, k
open(RUN + "/AutoATES_classifier_local.py", "w").write(code)
env = dict(os.environ, PYTHONPATH=RUN + "/shim")
subprocess.run([sys.executable, RUN + "/AutoATES_classifier_local.py"], check=True, env=env, cwd=W)
print("done:", os.listdir(W + "/outputs"))
