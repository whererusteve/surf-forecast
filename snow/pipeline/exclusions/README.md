# What the Snow Finder leaves out, and why

The pipeline (`snow/pipeline/build_zones.py`) removes these areas before it draws
any zones, so they never appear in the app for anyone. Each rebuild writes the
exact sources, dates and areas removed to `sources-<region>.json` in this folder.

| Removed | Why | Source |
|---|---|---|
| First Nations reserves (BC) | Not public land; access only with the Nation's permission | Canada Lands Survey: Indian Reserves (`CLAB_INDIAN_RESERVES`), BC Data Catalogue |
| Tribal reservations and off-reservation trust lands (US) | Same | US Census TIGERweb AIANNH layers |
| Cultural Places documented for cultural use (Squamish Nation Síiyamin and village sites, Líl̓wat Nation spirited-ground areas, In-SHUCK-ch sites) | Documented cultural use (Steve's rule, 2026-11-07) | BC Legal Planning Objectives (`RMP_PLAN_LEGAL_POLY_SVW`, objective "Cultural Places"); wording and exceptions in `snow/content/cultural_areas.json` |
| Operating ski resorts | Controlled, tenured terrain; the resort's rules apply | BC Controlled Recreation Areas with status Active (`REC_TENURE_ALPINE_SKI_AREAS_SP`); OpenStreetMap `landuse=winter_sports` for US resorts |
| Commercial cat-ski tenures (BC, granted tenures only) | Tenured commercial recreation areas | TANTALIS Crown Tenures (`TA_CROWN_TENURES_SVW`), purpose Commercial Recreation, sub-purpose Cat Ski |
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

**Highlighted, not removed** (Steve's decisions, 2026-11-07). Zones stay, and each one
says which of these it overlaps, with why and who to contact:

- Commercial heli-ski tenures (BC doesn't close them to the public).
- Proposed ski resorts that aren't operating (e.g. Garibaldi at Squamish on Brohm Ridge).
- First Nations' Cultural Management Areas in the Sea to Sky plan (areas with high cultural
  values where recreation isn't banned), with the Nation(s) to contact.
- Pipi7íyekw (Cerise Creek, beside Joffre Lakes Park): seasonal, with the park's cultural
  closure dates. Steve's exception: it closes only part of the year.
