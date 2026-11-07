# What the Snow Finder leaves out, and why

The pipeline (`snow/pipeline/build_zones.py`) removes these areas before it draws
any zones, so they never appear in the app for anyone. Each rebuild writes the
exact sources, dates and areas removed to `sources-<region>.json` in this folder.

| Removed | Why | Source |
|---|---|---|
| First Nations reserves (BC) | Not public land; access only with the Nation's permission | Canada Lands Survey: Indian Reserves (`CLAB_INDIAN_RESERVES`), BC Data Catalogue |
| Tribal reservations and off-reservation trust lands (US) | Same | US Census TIGERweb AIANNH layers |
| Cultural Places in the Sea to Sky and Lillooet land-use plans | Sites of cultural significance set out in law with the Nations | BC Legal Planning Objectives (`RMP_PLAN_LEGAL_POLY_SVW`, objective "Cultural Places") |
| Ski resort operating areas | Controlled, tenured terrain; the resort's rules apply | BC Controlled Recreation Areas (`REC_TENURE_ALPINE_SKI_AREAS_SP`); OpenStreetMap `landuse=winter_sports` for US resorts |
| Commercial heli-ski and cat-ski tenures (BC, granted tenures only) | Tenured commercial recreation areas | TANTALIS Crown Tenures (`TA_CROWN_TENURES_SVW`), purpose Commercial Recreation, sub-purpose Heli Ski / Cat Ski |
| Washington side of the Selkirks | No avalanche centre forecasts it (Steve's decision, 2026-11-07) | Idaho / Washington border meridian |
| Areas Steve removes in curation mode | Sacred sites that aren't mapped publicly, locals' requests, anything else he judges should stay off the map | `curated.json` (shapes only, never the reasons) |

**What the pipeline can't catch.** Most sacred and cultural sites are deliberately
not mapped, and the pipeline never tries to infer them. That's what curation mode
is for.

**Shown, not removed.** Some restrictions only limit how you get there. They change
which access modes the app offers, not which zones exist:

- Snowmobile closures: BC caribou closures and permit areas (Snowmobile Management
  Areas), Motor Vehicle Prohibition Regulation areas, provincial and national parks,
  conservancies, US designated Wilderness. In the US, sleds are only routed along
  Forest Service trails managed or open for snowmobiles.
- Cultural Management Areas (Sea to Sky plan): larger landscapes, flagged on the zone
  for now while Steve decides how to treat them.
