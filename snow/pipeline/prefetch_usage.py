"""Fetch the slow usage signals ahead of a build: python prefetch_usage.py [region ...]"""
import sys
from regions import REGIONS
import sources as S

for rid in (sys.argv[1:] or list(REGIONS)):
    b = S.bbox_str(REGIONS[rid]["bbox"])
    print(rid, "MIN reports:", len(S.min_locations(b)), flush=True)
    print(rid, "MIN titles:", len(S.min_titles(b)), flush=True)
    print(rid, "winter GPS points:", len(S.gps_winter_points(b)), flush=True)
