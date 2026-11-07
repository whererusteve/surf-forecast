# Build brief: Backcountry Snow Finder

Start a new Claude Code session on the `backcountry-snow` branch of `whererusteve/surf-forecast` and say:

> Read `prompts/backcountry-snow.md` and follow it.

Everything below is written for that session.

---

## 1. Who you're working with

Steve Andrews: writer, sound mixer, snowboarder of 30+ years, Canadian Avalanche Association member and certified Basic Avalanche Educator. He runs Alpine Islands (alpineislands.com), a backcountry education club built like a martial-arts dojo: steady progress through practice and discipline, not thrill-chasing. He is **not** primarily a coder.

- Explain changes in plain language, teach where it helps, and lead with outcomes.
- Steve writes the prose. Write functional placeholder copy, mark it clearly, and invite him to rewrite it.
- Treat his avalanche knowledge as expert. When the model and his field judgement disagree, ask him.
- Follow the repo's `CLAUDE.md`. Its rules apply here too.

## 2. What we're building

A companion to the surf app already in this repo (`app/`, `pipeline/`). Same idea, for mountains: **use weather forecasts, terrain data and satellite data to find where the snow is good right now, including lesser-known terrain, while making avalanche hazard impossible to miss.**

The surf app is the pattern. Read these first and reuse their approach (copy and adapt; don't import across apps):

| Surf app file | What to reuse |
|---|---|
| `pipeline/build_spots.py` | Offline discovery from elevation data → a JSON file the app loads |
| `app/js/scoring.js` + `tests/` | Pure, tested scoring functions with plain-language "why this score" notes |
| `app/js/main.js`, `detail.js` | Map + ranked list + detail panel, "At a time" vs "Best this week", daylight-only |
| `app/js/forecast.js` | Batched Open-Meteo requests, 1-hour Cache Storage, stale fallback |
| `app/js/reports.js`, `feedback.js` | Field reports saved on device, emailed with a machine-readable `DATA` line |
| `app/js/sun.js` | Sun position (needed even more here: aspect and solar effects) |

Build the new app in a **separate top-level folder `snow/`** (with `snow/pipeline/` and tests in `tests/snow/`), so the surf app stays untouched. GitHub Pages serves `main`, so once this merges the app lives at `https://whererusteve.github.io/surf-forecast/snow/`. If Steve later wants it under the Alpine Islands brand or its own repo, the folder moves cleanly.

## 3. Safety principles (non-negotiable)

These shape every design decision. If a feature conflicts with them, stop and ask Steve.

1. **Snow quality and avalanche hazard are separate, and never blended into one score.** The app answers "where is the snow good?" and shows "how dangerous is it?" beside it, always. Deep new snow and wind loading make snow better *and* hazard higher; one number would hide exactly the trade-off people need to see.
2. **The official avalanche forecast is the authority.** Show the current danger rating from Avalanche Canada (BC) or the Northwest Avalanche Center (WA) for each zone and elevation band, with a link to the full bulletin. The app never produces its own danger rating and never calls terrain "safe".
3. **Terrain exposure is shown, never hidden.** Show slope angle classes on every zone (<30° / 30–35° / 35–45° / >45°). Where official ATES ratings exist (Simple / Challenging / Complex), show them. Otherwise say the terrain is unrated.
4. **On high-danger days, promote lower-consequence options.** At danger 3 (Considerable) or higher, rankings should favour low-angle and treed terrain, and the UI should say why.
5. **Name what the model can't see:** buried weak layers, slab structure, cornices, glide cracks, local wind effects. Say so in the UI, near the scores.
6. **Education over hype,** in the Alpine Islands spirit: link to Avalanche Canada's trip-planning tools, AST courses and the Avaluator. No "send it" language.
7. **Respect access and territory:** First Nations land, closures (wildlife, caribou habitat, tenure areas), private land and parking rules.
8. **Field observations belong to the community.** The report feature should point people to Avalanche Canada's Mountain Information Network (MIN) for anything avalanche-related, as well as saving a snow report for our model checks.

## 4. Iteration 1 scope

Start small and get it right before expanding (the surf app went PNW coast first, world later):

- **Area:** the Sea-to-Sky corridor (Squamish → Whistler → Pemberton → Duffey Lake Road). Add the North Cascades around Mt Baker and Stevens Pass as the Washington pair if the data plumbing for NWAC is easy. Confirm with Steve first.
- **Season logic:** winter storm snow first. Spring corn is iteration 2.
- **Users:** Steve plus a few trusted, avalanche-trained testers.

## 5. How it should work

### 5a. Discovery pipeline (offline, Python, like `pipeline/build_spots.py`)

Turn terrain into candidate **zones**, each a patch of terrain with a consistent elevation band, aspect and slope class, within reach of access:

1. **Elevation model:** use a 30 m DEM (ETOPO's 450 m cells are far too coarse for mountains). Compute slope, aspect, elevation band (below treeline / treeline / alpine, using the avalanche forecast's own band definitions for that region) and curvature (gullies, ridges, convexities).
2. **Treeline and cover:** land cover (forest vs open) to separate tree skiing from open alpine.
3. **Access:** distance and elevation gain from road-accessible trailheads or parking (OpenStreetMap / BC Recreation Sites and Trails). Limit iteration 1 to terrain reachable in a day (e.g. ≤ 1,200 m gain and ≤ 10 km from the car; make these settings).
4. **Wind exposure:** for each zone, which wind directions load it (lee) and which scour it (windward). Use ridge orientation and a simple upwind-terrain sheltering calculation, similar in spirit to the surf app's swell-window ray casting.
5. **Zone potential (0–1):** good ski/ride fall line, consistent pitch, size, access. Keep it separate from hazard.
6. **Known zones:** seed `snow/pipeline/known_zones.json` with well-known areas (ask Steve for his list) and tag nearby candidates "known" vs "lesser-known", as the surf app does.
7. Output `snow/data/zones.json` with zone polygons simplified for the web, their attributes, a shared forecast grid point, and the avalanche forecast region ID.

### 5b. Snow quality model (`snow/js/scoring.js`, pure functions, tested)

Score each zone hourly (and "best this week" by daylight hour). Starting factors to refine with Steve:

| Factor | Signal | Notes |
|---|---|---|
| Recent snow | Snowfall last 24/48/72 h at the zone's elevation | More is better, up to a point |
| Snow density | Snowfall vs precipitation ratio, temperature during snowfall | Cold, low-density snow scores higher |
| Rain line | Freezing level vs zone elevation during precipitation | Rain on snow is a big negative |
| Warming / sun | Temperature trend and clear-sky sun on the aspect since the storm | Sun crusts on solar aspects; settles snow |
| Wind effect | Wind speed and direction since the storm, against the zone's exposure | Scoured or wind-pressed snow is lower quality. **Loading is a hazard flag, not a quality bonus.** |
| Visibility | Cloud and fog | Matters for open alpine much more than trees |
| Base | Modelled snow depth or nearby station depth | Too thin = rocks, stumps, open creeks |

Every factor needs a plain-language note, like the surf app's `explain()`. Example: *"38 cm of cold, light snow since Tuesday, with little wind at treeline."*

### 5c. Hazard panel (shown with every score, never merged into it)

- Danger rating by elevation band from the official forecast, with the forecast date, problems (e.g. wind slab, persistent slab) and a link.
- If the forecast is missing or out of date: say so clearly and grey out scores rather than showing them as normal.
- The zone's slope-angle mix, ATES rating if available, and any "this zone is loaded by today's wind" flag.

### 5d. App

Reuse the surf app's layout: map with terrain/satellite basemaps and a slope-angle shading layer, ranked list, zone detail, "At a time" / "Best this week", forecast caching. Add an elevation-band selector. Mobile matters: people check this in the parking lot.

### 5e. Field reports

Adapt `reports.js` / `feedback.js`: snow surface (blower / powder / wind-affected / crust / corn / mank / breakable crust), depth of new snow, elevation and aspect actually ridden, and red flags seen (recent avalanches, cracking, whumpfing). Record the model's prediction alongside, as the surf app does. Point people to the Mountain Information Network to share avalanche observations with everyone.

## 6. Data sources to evaluate

Verify each before building on it: that it still exists, how to call it, its terms of use, and whether a website may call it directly from the browser (CORS). **Ask Steve before relying on any source whose terms are unclear.** For Avalanche Canada data in particular, check the terms and whether permission is needed; Steve may know whom to contact.

| Need | Candidates to check |
|---|---|
| Mountain weather forecast | Open-Meteo Forecast API (snowfall, freezing level, temperature, wind, cloud; the `elevation` parameter for downscaling; Canada's high-resolution GEM HRDPS model) |
| Avalanche forecasts | Avalanche Canada public API (`api.avalanche.ca`); avalanche.org public API for US centres including NWAC |
| Elevation (30 m) | Copernicus GLO-30 DEM (AWS open data); Canadian CDEM / HRDEM; USGS 3DEP |
| Land cover / treeline | ESA WorldCover 10 m (AWS open data) |
| Snow stations | BC River Forecast Centre automated snow weather stations; USDA NRCS SNOTEL (WA); Avalanche Canada / NWAC weather stations |
| Satellite snow cover | Sentinel-2 snow index via a public STAC catalogue (e.g. Element 84 Earth Search on AWS); MODIS/VIIRS snow cover (NASA; may need a login). Probably iteration 2. |
| Terrain ratings | ATES ratings from Parks Canada / Avalanche Canada / BC sources, where published |
| Access | OpenStreetMap; BC Recreation Sites and Trails; closures from BC government sources |

**Network:** this cloud environment only reaches allowed hosts. When a request is refused by the proxy, use the environment tools to propose adding exactly the hosts needed. Don't work around the proxy.

## 7. Repo and code rules

- Same rules as the surf app (see `CLAUDE.md`): no-build static site, plain ES modules, Leaflet from jsDelivr with SRI hashes, relative URLs, generated data never hand-edited.
- Pure scoring functions with tests for every rule. Add `tests/snow/*.test.mjs` to `npm test` without breaking the surf tests.
- Keep forecast requests within Open-Meteo's limits (the surf app keeps ~200 points per load and caches for an hour). Mountain weather varies fast with elevation, so prefer requesting by elevation band per grid point over adding points.
- Update `README.md` with a plain-language "Backcountry Snow Finder" section, and update `CLAUDE.md` with any rules future sessions need.
- Work on the `backcountry-snow` branch. Commit as you go, push the branch, and **don't merge to `main`** until Steve has tried it and says so.
- Open-Meteo's free tier is non-commercial. Flag this if Steve talks about monetizing.

## 8. Order of work (check in with Steve at each ★)

1. ★ **Ask Steve the questions in section 9** before writing code.
2. Verify the data sources (section 6). ★ Report what's available, what's blocked and any terms issues.
3. Build the terrain pipeline for the iteration-1 area. ★ Show Steve a map of candidate zones next to his known zones, and ask whether the zone boundaries, slope classes and access cut-offs look right to someone who rides there.
4. Avalanche forecast integration and hazard panel. ★ Check the wording and layout with Steve: this is the most safety-critical part.
5. Snow quality model + tests, checked against a recent storm cycle Steve remembers.
6. The app UI, caching, field reports.
7. ★ Hand over: what works, what's uncertain, how to test it, and suggested next steps.

## 9. Questions for Steve before starting

1. Which zones should iteration 1 cover, and which do you consider "known"? (A list of names or trailheads is enough.)
2. Include the North Cascades in iteration 1, or BC only?
3. Day trips only, or also hut-based and multi-day terrain?
4. Who are the testers, and are they all avalanche-trained? Should the app require acknowledging a short safety notice before first use?
5. Any terrain or areas that should never appear in the app (sensitive, closed, culturally significant, or locals' stashes)?
6. Should this connect to Alpine Islands (belt levels, destination guides, branding) now or later?
7. A dedicated email address for field reports?

## 10. Definition of done for iteration 1

- Steve can open the app on his phone, see where the snow should be best today and this week in the chosen area, and see the official avalanche danger beside every score.
- Every score has a plain-language explanation, and the app states what it can't know.
- Tests pass. The surf app is unchanged and still works.
- Field reports work end to end.
- The branch is pushed with a clear summary for Steve.
