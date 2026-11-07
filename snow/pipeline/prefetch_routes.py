"""Fill the ski-route grid cache from ohsome, retrying gently: python prefetch_routes.py [region ...]"""
import sys, time
from regions import REGIONS
import sources as S

todo = sys.argv[1:] or list(REGIONS)
for attempt in range(12):
    left = []
    for rid in todo:
        cells, complete = S.ohsome_route_grid(S.bbox_str(REGIONS[rid]["bbox"]))
        print(rid, "complete" if complete else "incomplete", len(cells), "squares with routes", flush=True)
        if not complete:
            left.append(rid)
    if not left:
        print("ALL DONE", flush=True)
        break
    todo = left
    time.sleep(600)
