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
- **Testers are Steve and other Alpine Islands members.**
- **Email reminder:** the address for field reports isn't set yet. Steve will create one later. **At the end of every update you hand over, remind Steve to send you the feedback email address**, until it's set in the app's config. (The surf app's `FEEDBACK_EMAIL` in `app/js/config.js` is also still empty; remind him about both.)

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
2. **The official avalanche forecast is the authority.** Show the current danger rating from Avalanche Canada (BC), the Northwest Avalanche Center (Washington Cascades) or the Idaho Panhandle Avalanche Center (Selkirks) for each zone and elevation band, with a link to the full bulletin. The app never produces its own danger rating and never calls terrain "safe".
3. **Terrain exposure is shown, never hidden.** Show slope angle classes on every zone (<30° / 30–35° / 35–45° / >45°). Where official ATES ratings exist (Simple / Challenging / Complex), show them. Otherwise say the terrain is unrated.
4. **On high-danger days, promote lower-consequence options.** At danger 3 (Considerable) or higher, rankings should favour low-angle and treed terrain, and the UI should say why.
5. **Name what the model can't see:** buried weak layers, slab structure, cornices, glide cracks, local wind effects. Say so in the UI, near the scores.
6. **Education over hype,** in the Alpine Islands spirit: link to Avalanche Canada's trip-planning tools, AST courses and the Avaluator. No "send it" language.
7. **Respect access and territory:** First Nations land, closures (wildlife, caribou habitat, tenure areas), private land and parking rules.
8. **Field observations belong to the community.** The report feature should point people to Avalanche Canada's Mountain Information Network (MIN) for anything avalanche-related, and to the regional US avalanche centres' observation forms in Washington and Idaho, as well as saving a snow report for our model checks.
9. **Only show legal access.** Show snowmobile ("sled") or helicopter options only where that access is legal. In the US, no motorized use is allowed in designated Wilderness or North Cascades National Park, and snowmobiles must follow the Forest Service over-snow vehicle use maps. Wildlife closures, such as the mountain caribou closures in the Selkirks, apply too. Heli access only appears where a permitted commercial operator flies. Never suggest private or illegal landings.
10. **Some places are left out entirely.** Sacred and culturally significant sites, First Nations reserves and tribal reservation lands (unless access is explicitly public), and controlled or tenured recreation areas (ski resort boundaries, BC Controlled Recreation Areas, commercial cat/heli-ski tenures) are removed in the pipeline, not just hidden in the app. See 5f.

## 4. Iteration 1 scope

Start small and get it right before expanding (the surf app went PNW coast first, world later):

- **Areas (Steve's choice):**
  - **BC:** the Sea-to-Sky corridor (Squamish → Whistler → Pemberton → Duffey Lake Road). Avalanche Canada.
  - **Washington:** the North Cascades (Mt Baker, Highway 20, Stevens Pass and the zones in between). Northwest Avalanche Center (NWAC).
  - **Idaho/Washington:** the southern Selkirks (Selkirk Crest above Sandpoint and northeast Washington). Idaho Panhandle Avalanche Center (verify which centre covers which part).
  - Confirm with Steve: does "southern Selkirks" include the BC side too (Kootenay Pass, Nelson area, Avalanche Canada)? Does Sea-to-Sky stay in?
- **Depth:** include well-known zones **and deep backcountry**, with an estimated travel time for every zone (see 5a). Multi-day objectives are in, flagged as such.
- **Season logic:** winter storm snow first. Spring corn is iteration 2.
- **Users:** Steve and Alpine Islands members.

## 5. How it should work

### 5a. Discovery pipeline (offline, Python, like `pipeline/build_spots.py`)

Turn terrain into candidate **zones**, each a patch of terrain with a consistent elevation band, aspect and slope class, within reach of access:

1. **Elevation model:** use a 30 m DEM (ETOPO's 450 m cells are far too coarse for mountains). Compute slope, aspect, elevation band (below treeline / treeline / alpine, using the avalanche forecast's own band definitions for that region) and curvature (gullies, ridges, convexities).
2. **Treeline and cover:** land cover (forest vs open) to separate tree skiing from open alpine.
3. **Access and travel time:** find the route from road-accessible trailheads or winter parking (OpenStreetMap, BC Recreation Sites and Trails, Forest Service data) to every zone, including deep backcountry, and estimate travel time for each access mode:
   - **Skin (non-motorized):** use the Munter method, the standard ski-touring planning formula. Count 1 unit per km of distance plus 1 unit per 100 m of climbing, at about 4 units per hour uphill for an average touring party. Make the speed a setting so people can set their own pace. Ask Steve for his rule of thumb.
   - **Sled-assisted:** snowmobile along legal over-snow routes (Forest Service roads, designated riding areas) at a conservative average speed (a setting), then skin the rest. Only where sleds are legal (principle 9).
   - **Heli bump:** only where a permitted commercial operator flies. Show "heli access via [operator]" with a link, not a time we invent.
   - Show the total time, the climb, and the main legs (e.g. *"Sled 22 km, ~1 h · skin 900 m, ~2.5 h"*). Flag anything over ~5 hours one way as "overnight / multi-day". Let people filter by maximum travel time and access mode.
   - Model the route along drainages and low-angle terrain where possible. Flag zones where the best approach crosses or runs under avalanche terrain ("approach exposed to avalanche paths"). Travel times are estimates: say so, and never present them as route advice.
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

### 5f. Removing areas (automatic exclusions + Steve's curation)

**Automatic, in the pipeline.** Remove zones that overlap:
- First Nations reserves (Canada) and tribal reservation and trust lands (US), unless access is explicitly public
- Sacred and culturally significant sites wherever a public source exists. Most are deliberately not mapped, so the pipeline can't catch them all; that's what Steve's curation is for. Never try to infer or reveal unmapped sites.
- Ski resort operating boundaries, BC Controlled Recreation Areas, and commercial cat-ski and heli-ski tenures
- Closures such as wildlife and caribou closures, and areas where recreation is prohibited

Keep each exclusion source and its date in `snow/pipeline/exclusions/`, and list in the README what is excluded and why.

**Steve's curation ("comb through"):**
- Add a curation mode turned on by a URL flag (e.g. `?curate=1`) so regular testers don't see it. It adds a **"Remove this area"** button on each zone, plus a way to draw a box or polygon around a larger area to remove.
- Removals are saved on the device (like surf reports) and listed with **Email removal list** and **Download** buttons. Each removal can carry an optional private note, e.g. "sacred site" or "locals' stash".
- Removals are stored as **geographic shapes, not zone IDs** (IDs change when data is rebuilt). They go into `snow/pipeline/exclusions/curated.json`, and the pipeline drops those areas **for everyone** on the next rebuild. Hiding them only on Steve's phone isn't enough.
- Never publish the reason notes; they stay in the private list. Treat the curated list as sensitive. If Steve prefers it not to live in the public repo, keep only the shapes, with no notes.
- After a rebuild, report to Steve how many zones each removal took out.

## 6. Data sources to evaluate

Verify each before building on it: that it still exists, how to call it, its terms of use, and whether a website may call it directly from the browser (CORS). **Ask Steve before relying on any source whose terms are unclear.** For Avalanche Canada data in particular, check the terms and whether permission is needed; Steve may know whom to contact.

| Need | Candidates to check |
|---|---|
| Mountain weather forecast | Open-Meteo Forecast API (snowfall, freezing level, temperature, wind, cloud; the `elevation` parameter for downscaling; Canada's high-resolution GEM HRDPS model) |
| Avalanche forecasts | Avalanche Canada public API (`api.avalanche.ca`); avalanche.org public API for US centres, including NWAC and the Idaho Panhandle Avalanche Center |
| Elevation (30 m) | Copernicus GLO-30 DEM (AWS open data); Canadian CDEM / HRDEM; USGS 3DEP |
| Land cover / treeline | ESA WorldCover 10 m (AWS open data) |
| Snow stations | BC River Forecast Centre automated snow weather stations; USDA NRCS SNOTEL (WA); Avalanche Canada / NWAC weather stations |
| Satellite snow cover | Sentinel-2 snow index via a public STAC catalogue (e.g. Element 84 Earth Search on AWS); MODIS/VIIRS snow cover (NASA; may need a login). Probably iteration 2. |
| Terrain ratings | ATES ratings from Parks Canada / Avalanche Canada / BC sources, where published |
| Access & trailheads | OpenStreetMap (roads, trailheads, winter parking, huts); BC Recreation Sites and Trails; USFS roads and trails |
| Motorized legality | USFS over-snow vehicle use maps (Okanogan-Wenatchee, Mt Baker-Snoqualmie, Colville and Idaho Panhandle national forests); Wilderness boundaries; National Park boundaries; BC snowmobile closures; Selkirk caribou closures (BC and Idaho) |
| Heli operators | Permitted operators and their permit or tenure areas (e.g. USFS permits in the North Cascades; BC commercial recreation tenures) |
| Exclusions | Canada Lands / Indian Reserve boundaries; US tribal land boundaries (Census or BIA); ski area boundaries (OSM `landuse=winter_sports`, USFS permits); BC Controlled Recreation Areas and commercial recreation tenures (BC Data Catalogue); published cultural or heritage sites |

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
3. Build the terrain pipeline for the iteration-1 areas, with automatic exclusions and travel times. ★ Show Steve a map of candidate zones next to his known zones, and ask whether the zone boundaries, slope classes and travel times look right to someone who rides there.
4. Add curation mode so Steve can start combing through and removing areas while the rest gets built.
5. Avalanche forecast integration and hazard panel. ★ Check the wording and layout with Steve: this is the most safety-critical part.
6. Snow quality model + tests, checked against a recent storm cycle Steve remembers.
7. The app UI, caching, field reports.
8. ★ Hand over: what works, what's uncertain, how to test it, and suggested next steps.

**At every ★ check-in and hand-over, end with the email reminder** (section 1) until the address is set.

## 9. Questions for Steve before starting

Already answered: areas (Sea-to-Sky, North Cascades, southern Selkirks), deep backcountry with travel times, testers (Steve + Alpine Islands members), curation plus automatic exclusions, and email address (later: remind him).

Still to ask:

1. Does "southern Selkirks" include the BC side (Kootenay Pass, Nelson)? Does Sea-to-Sky stay in iteration 1?
2. Which zones do you consider "known" in each area? (A list of names or trailheads is enough.)
3. Your skinning pace rule of thumb, and a sensible average sled speed, for the travel-time defaults?
4. Are all Alpine Islands testers avalanche-trained (AST 1 or equivalent)? Should the app require acknowledging a short safety notice before first use?
5. Mountains that are both widely toured and culturally significant (e.g. Koma Kulshan / Mt Baker to the Nooksack and Lummi peoples): keep them in with an acknowledgement, or treat them some other way? Should we reach out to the relevant Nations for guidance?
6. Should this connect to Alpine Islands (belt levels, destination guides, branding) now or later?

## 10. Definition of done for iteration 1

- Steve can open the app on his phone, see where the snow should be best today and this week in the chosen area, and see the official avalanche danger beside every score.
- Every score has a plain-language explanation, and the app states what it can't know.
- Tests pass. The surf app is unchanged and still works.
- Every zone shows estimated travel time by legal access mode, and travel-time filters work.
- Automatic exclusions are applied, and Steve can remove areas in curation mode and have them dropped for everyone on rebuild.
- Field reports work end to end.
- The branch is pushed with a clear summary for Steve, ending with the email reminder if the address still isn't set.
