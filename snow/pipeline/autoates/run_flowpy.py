"""Run Flow-Py (from AutoATES v2.0) on the Spearhead test area with AutoATES's shipped settings."""
from pathlib import Path
import sys, multiprocessing as mp
SRC = str(Path(__file__).resolve().parent / "src" / "FlowPy_detrainment")
RUN = str(Path(__file__).resolve().parent)
sys.path.insert(0, RUN + "/shim")
sys.path.insert(1, SRC)
if __name__ == "__main__":
    mp.set_start_method("spawn")
    import main as flowpy
    w = RUN + "/work"
    flowpy.main(["23", "8", w, w + "/PRA/DEM_f32.tif", w + "/PRA/PRA_binary.tif"],
                {"forest": w + "/PRA/FOREST_f32.tif", "flux": "0.003", "max_z": "270"})
