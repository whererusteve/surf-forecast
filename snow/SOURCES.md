# Backcountry Snow Finder: data sources checked

Checked 2026-11-07 from the cloud build environment. "Reachable" means the build
environment can download it; browser access (CORS) is noted where it matters.

| Need | Source | Status | Terms / notes |
|---|---|---|---|
| Mountain weather | Open-Meteo Forecast API (incl. GEM HRDPS, `elevation=` downscaling) | Works | Free tier is **non-commercial only**: under 600 calls/min, 5,000/h, 10,000/day, CC BY 4.0 attribution. Sites with ads or subscriptions count as commercial. |
| Avalanche forecasts (BC) | Avalanche Canada public API, documented at avalanche.ca/api-docs (`avcan-services-api.prod.avalanche.ca`, also `api.avalanche.ca`) | Works, CORS open | API docs list forecasts by area or point, MIN submissions and weather stations, with no stated usage terms. Website terms say material "may not be reproduced or copied without prior written consent". **Ask Avalanche Canada for written OK.** Early season: one province-wide bulletin for now. |
| Avalanche forecasts (US) | avalanche.org public API `/v2/public/products/map-layer` (NWAC, IPAC) | Works, CORS open | Terms not found yet. NWAC and IPAC show "no rating" until their season starts. |
| Selkirk coverage | IPAC "Selkirk Mountains" zone | Checked | Covers Idaho only (lon -117.02 to -116.43). **The Washington side of the Selkirks has no avalanche centre forecast.** |
| Elevation 30 m | Copernicus GLO-30 DEM on AWS | Works | Open licence, attribution to ESA/Copernicus. |
| Land cover / treeline | ESA WorldCover 10 m on AWS | Works | CC BY 4.0. |
| BC land status | BC Data Catalogue WFS (`openmaps.gov.bc.ca`) | Works | Layers found: Indian Reserves (`CLAB_INDIAN_RESERVES`), alpine ski area tenures, ATES-mapped area boundaries (116 areas, names only, not ratings per slope), caribou snowmobile closures (`PARKS_SNOWMOBILE_CAR_POLY`), national parks, recreation sites and trails. Still to find: heli/cat commercial recreation tenures, Controlled Recreation Areas. |
| US tribal lands | Census TIGERweb AIANNH | Works | Public domain. |
| US motorized rules | USFS EDW map services (MVUM etc.) | Works | Public domain. |
| Snow stations (WA) | NRCS SNOTEL (AWDB REST API) | Works | Public domain. |
| BC highway closures | DriveBC Open511 | Works | Open Government Licence BC. |
| OSM routes and trailheads | Overpass API | **Blocked by the server** (resets connections from cloud addresses) | Fallback: download regional OSM extracts and filter offline. |
| OSM public GPS traces | `api.openstreetmap.org/api/0.6/trackpoints` | Works | Max 0.25° box, 5,000 points per page; non-trackable traces come shuffled (privacy). Use aggregated counts only. |
| Usage heatmap | Strava Global Heatmap | **Not usable** | Strava terms: "Automated access to or collection of data from the Services ... is prohibited", logged in or not. Steve chose open data instead. |
| Territory | Native Land Digital API | Needs an API key | Since late 2024 every request needs a key, issued after agreeing to their Data Sovereignty Treaty. Starting point only; confirm with each Nation's own site. |
| Embedding | GitHub Pages | OK | No `X-Frame-Options` or `frame-ancestors` header, so iframes on alpineislands.com are allowed. |
| Avalanche terrain (model) | AutoATES v2.0 (Toft et al. 2024, NHESS; github.com/AutoATES/AutoATES-v2.0) | Trial run on the Spearhead (Nov 2026) | GPL-3.0 code, run from a separate clone, never copied in. Outputs are data. Cite doi:10.5194/nhess-24-1779-2024. Model estimate, not an official ATES rating. See `snow/pipeline/autoates/`. |
