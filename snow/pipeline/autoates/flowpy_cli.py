"""Run Flow-Py (part of AutoATES v2.0) from the command line, unchanged.

    python flowpy_cli.py <workdir> <dem.tif> <release.tif> <forest.tif>

Settings are the ones AutoATES ships with: alpha 23, exponent 8, flux 0.003, max z 270.
Needs PYTHONPATH=<this folder>/shim:<AutoATES clone>/FlowPy_detrainment.
"""
import multiprocessing as mp
import sys

if __name__ == "__main__":
    mp.set_start_method("spawn")
    import main as flowpy  # Flow-Py's main.py

    work, dem, release, forest = sys.argv[1:5]
    flowpy.main(["23", "8", work, dem, release], {"forest": forest, "flux": "0.003", "max_z": "270"})
