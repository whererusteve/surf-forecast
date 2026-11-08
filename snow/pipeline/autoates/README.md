# AutoATES v2.0 in the Snow Finder

Steve approved AutoATES after this trial (2026-11-08). The region-wide run is
`snow/pipeline/autoates_tiles.py` (resumable tiles, pinned AutoATES commit); `flowpy_cli.py` and
`shim/` here are shared with it. The trial scripts below are kept for reference.

## The Spearhead trial (Nov 2026)

A test of [AutoATES v2.0](https://github.com/AutoATES/AutoATES-v2.0) (Toft et al., 2024,
NHESS 24, 1779–1793, doi:10.5194/nhess-24-1779-2024) against the Snow Finder's own
"exposed to avalanche terrain" rule, on a ~15 x 15 km square around the Spearhead Range.

AutoATES is GPL-3.0, so its code is **not** copied into this repo. These scripts run it
unchanged from a separate clone; only the map outputs (data) come back here.

## Run it

```bash
cd snow/pipeline/autoates
git clone --depth 1 https://github.com/AutoATES/AutoATES-v2.0 src
pip install psutil
python3 prepare.py                       # DEM + percent canopy cover, 30 m UTM 10N
(cd work && PYTHONPATH=../shim python3 ../src/PRA/PRA_AutoATES-v2.0.py pcc PRA/DEM.tif PRA/FOREST.tif 2 0.5 0 180 0.15 3)
PYTHONPATH=shim:src/FlowPy_detrainment python3 run_flowpy.py   # runout, ~15 min for this square on 4 cores
python3 classify.py
python3 compare.py
```

`shim/` stands in for the three GDAL calls (rasterio does the work) and for the PyQt GUI
imports Flow-Py has but the terminal run never uses. Flow-Py needs float rasters
(`*_f32.tif`), otherwise its running totals overflow 16-bit integers.

Settings: AutoATES defaults (wind-shelter radius 60 m = 2 cells at 30 m, PRA threshold 0.15,
sieve 3), Flow-Py alpha 23, exponent 8, flux 0.003, max z 270, with forest; forest type `pcc`
from ESA WorldCover tree fraction.

## Result (Spearhead square, 90 m cells)

| | |
|---|---|
| AutoATES classes | simple 44%, challenging 16%, complex 34%, extreme 7% |
| Our rule flags | 58% of the area |
| Of AutoATES "simple" cells, ours flags | 53% (false alarms, mostly forested valley walls) |
| AutoATES challenging+ caught by ours | 62% (misses glaciated benches under peaks) |

Caveats: Copernicus GLO-30 is a surface model (includes tree height) where AutoATES expects
bare-earth elevation; WorldCover tree fraction is only a stand-in for canopy cover; AutoATES
is itself a model, validated at F1 ≈ 77% against an expert ATES map (Bow Summit).
