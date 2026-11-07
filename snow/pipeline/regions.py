"""
Areas the Snow Finder covers, and the settings that differ between them.

Each region is processed on its own and written to its own data file, so the app
only loads (and only fetches forecasts for) the region someone is looking at.
"""

REGIONS = {
    "sea-to-sky": dict(
        name="Sea-to-Sky",
        country="CA",
        # Squamish -> Whistler -> Pemberton -> Duffey Lake Road (to Cayoosh/Lillooet side)
        bbox=dict(lat_min=49.60, lat_max=50.80, lon_min=-123.55, lon_max=-121.85),
        dem_tiles=["N49_00_W124", "N49_00_W123", "N49_00_W122",
                   "N50_00_W124", "N50_00_W123", "N50_00_W122"],
        worldcover_tiles=["N48W126", "N48W123"],
        avalanche_centres=["avcan"],
    ),
    "north-cascades": dict(
        name="North Cascades",
        country="US",
        # Mt Baker, Highway 20 (Washington Pass / Mazama side) and south to Stevens Pass
        bbox=dict(lat_min=47.55, lat_max=49.00, lon_min=-122.00, lon_max=-120.35),
        dem_tiles=["N47_00_W122", "N47_00_W121", "N48_00_W122", "N48_00_W121"],
        worldcover_tiles=["N45W123", "N48W123"],
        avalanche_centres=["NWAC"],
    ),
    "south-selkirks": dict(
        name="Southern Selkirks",
        country="CA+US",
        # Kootenay Pass and Nelson (BC), Selkirk Crest above Sandpoint (Idaho).
        # The Washington side has no avalanche centre forecast, so it is left out
        # (Steve's decision, 2026-11-07): see `drop_washington` below.
        bbox=dict(lat_min=48.30, lat_max=49.85, lon_min=-117.80, lon_max=-116.40),
        dem_tiles=["N48_00_W118", "N48_00_W117", "N49_00_W118", "N49_00_W117"],
        worldcover_tiles=["N48W120", "N48W117"],
        avalanche_centres=["avcan", "IPAC"],
        drop_washington=True,
    ),
}

# The Idaho / Washington border runs along this meridian from the Canadian border
# south past the Selkirks (117 deg 02' 27" W).
WA_ID_BORDER_LON = -117.0408
