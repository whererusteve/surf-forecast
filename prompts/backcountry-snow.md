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
- **Feedback email:** `Gnar-Data@proton.me` (set 2026-11-07) for both apps. The reminder is no longer needed.

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
10. **Some places are left out entirely.** These are removed in the pipeline, not just hidden in the app (see 5f):
    - specific sacred or cultural sites that a Nation asks people to avoid
    - First Nations reserves and tribal reservation lands (unless access is explicitly public)
    - controlled or tenured recreation areas: ski resort boundaries, BC Controlled Recreation Areas, commercial cat/heli-ski tenures
11. **Culturally significant mountains that are widely toured stay in, with an acknowledgement** (Steve's decision). Examples: Koma Kulshan (Mt Baker) for the Nooksack and Lummi peoples; Nch'kay (Mt Garibaldi) for the Squamish Nation. Every zone shows whose territory it's in, and significant places get a short acknowledgement covering:
    - the place's name in the Nation's own language
    - its history or story, **only as the Nation itself has shared it publicly**, credited with a link to the source
    - if no story is publicly shared, why the place matters
    - a closing line asking visitors to walk gently and with respect

    **Never invent, embellish or paraphrase a story beyond the source.** Some stories aren't meant for outsiders; if a source isn't clearly public and from the Nation, leave the story out. Use Native Land Digital (native-land.ca) only as a starting point for whose territory a zone is in, and confirm with the Nations' own websites. **Steve reviews every acknowledgement before it goes live.** Keep them in one editable file (e.g. `snow/content/acknowledgements.json`) so he can edit the wording.
12. **Permit systems and daily closures are shown, not routed around.** Some areas need permits or close day to day, e.g. the Parks Canada winter permit system at Rogers Pass, where restricted areas change with highway avalanche control, or highway avalanche-control closures at Kootenay Pass. The app must show the requirement and link to the live status. If it can't confirm the status, it says so.

## 4. Iteration 1 scope

Start small and get it right before expanding (the surf app went PNW coast first, world later):

- **Areas (Steve's choice), in two phases:**
  - **Phase 1: known zones plus deep-backcountry discovery**
    - **Sea-to-Sky (BC):** Squamish → Whistler → Pemberton → Duffey Lake Road. Avalanche Canada.
    - **North Cascades (WA):** Mt Baker, Highway 20, Stevens Pass and the zones in between. Northwest Avalanche Center (NWAC).
    - **Southern Selkirks, both sides of the border:** Kootenay Pass and the Nelson area in BC (Avalanche Canada); the Selkirk Crest above Sandpoint and northeast Washington (Idaho Panhandle Avalanche Center; verify which centre covers which part).
  - **Phase 1b: known zones only, across the rest of BC.** Steve wants most of BC's established backcountry in, starting with known zones only. For example: North Shore, Coquihalla, Rogers Pass, Revelstoke, Golden, Monashees, Purcells, Kootenay Lake, Vancouver Island and the Northwest. Use the usage data (5a, step 6) to find them, and confirm the list with Steve. Deep-backcountry discovery for these regions comes later.
- **Depth:** in phase 1, include well-known zones **and deep backcountry**, with an estimated travel time for every zone (see 5a). Multi-day objectives are in, flagged as such.
- **Season logic:** winter storm snow first. Spring corn is iteration 2.
- **Users:** Steve and Alpine Islands members, assumed avalanche-trained (AST 1 or equivalent). A disclaimer at the front must be accepted before first use (see 5d).
- **Alpine Islands:** connect now. Deliver a page Steve can put on alpineislands.com (see 5g).

## 5. How it should work

### 5a. Discovery pipeline (offline, Python, like `pipeline/build_spots.py`)

Turn terrain into candidate **zones**, each a patch of terrain with a consistent elevation band, aspect and slope class, within reach of access:

1. **Elevation model:** use a 30 m DEM (ETOPO's 450 m cells are far too coarse for mountains). Compute slope, aspect, elevation band (below treeline / treeline / alpine, using the avalanche forecast's own band definitions for that region) and curvature (gullies, ridges, convexities).
2. **Treeline and cover:** land cover (forest vs open) to separate tree skiing from open alpine.
3. **Access and travel time:** find the route from road-accessible trailheads or winter parking (OpenStreetMap, BC Recreation Sites and Trails, Forest Service data) to every zone, including deep backcountry, and estimate travel time for each access mode:
   - **Skin (non-motorized):** use the Munter method, the standard ski-touring planning formula. Count 1 unit per km of distance plus 1 unit per 100 m of climbing, at about 4 units per hour uphill for an average touring party. Steve: "just use the usual method", so use Munter's standard rates as defaults, state them in the UI, and make the pace a setting.
   - **Sled-assisted:** snowmobile along legal over-snow routes (Forest Service roads, designated riding areas) at a conservative average speed (a setting; state the default and why), then skin the rest. Only where sleds are legal (principle 9).
   - **Heli bump:** only where a permitted commercial operator flies. Show "heli access via [operator]" with a link, not a time we invent.
   - **Lift-assisted:** where a resort allows backcountry access through gates (e.g. many Sea-to-Sky tours, including the Spearhead Traverse, start from Whistler Blackcomb), use the lift-top or gate as the start. Note that a lift ticket and the resort's access rules apply. The resort's own terrain stays excluded (principle 10).
   - Show the total time, the climb, and the main legs (e.g. *"Sled 22 km, ~1 h · skin 900 m, ~2.5 h"*). Flag anything over ~5 hours one way as "overnight / multi-day". Let people filter by maximum travel time and access mode.
   - Model the route along drainages and low-angle terrain where possible. Flag zones where the best approach crosses or runs under avalanche terrain ("approach exposed to avalanche paths"). Travel times are estimates: say so, and never present them as route advice.
4. **Wind exposure:** for each zone, which wind directions load it (lee) and which scour it (windward). Use ridge orientation and a simple upwind-terrain sheltering calculation, similar in spirit to the surf app's swell-window ray casting.
5. **Zone potential (0–1):** good ski/ride fall line, consistent pitch, size, access. Keep it separate from hazard.
6. **Known vs lesser-known from real usage (Steve's approach).** Rather than a hand-made list, measure how much each zone is actually travelled from activity heatmaps and public tracks. Steve's test case: in the Spearhead Range, the Spearhead Traverse itself is heavily travelled, while the north-facing slopes running toward Wedge Creek see far less. The data should show that contrast clearly.
   - **Check terms first.** The obvious source, the Strava Global Heatmap, needs a logged-in account and its terms likely forbid reuse in third-party apps. Read the current terms and ask Steve before using it; never scrape it. Then evaluate open alternatives:
     - OpenStreetMap ski-touring routes (`piste:type=skitour`, `route=ski`) and OSM's public GPS traces (ODbL licence)
     - the locations of Mountain Information Network and US avalanche-centre observations, as a proxy for where people go
     - guidebook or route databases whose terms allow it
   - Give each zone a **use level**, "well-travelled" / "occasional" / "little sign of travel", and show it. Use only aggregated data, never individual people's tracks.
   - Say plainly that little-travelled terrain also has the least local information: fewer tracks to read, fewer observations, more uncertainty.
   - Seed `snow/pipeline/known_zones.json` with named zones from these sources, for Steve to check.
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

Reuse the surf app's layout: map with terrain/satellite basemaps and a slope-angle shading layer, ranked list, zone detail, "At a time" / "Best this week", forecast caching. Add an elevation-band selector, a use-level filter, and travel-time and access-mode filters. Mobile matters: people check this in the parking lot.

- **Disclaimer up front:** on first use, a short notice the person must accept before seeing any scores. It covers:
  - this is a planning aid, not an avalanche forecast
  - users are assumed to have avalanche training (AST 1 or equivalent)
  - the official avalanche bulletin comes first
  - what the model can't see
  - that you're responsible for your own decisions

  Remember acceptance on the device, and show the notice again when its wording changes (store a version number). The wording is Steve's to write; put clearly marked placeholder text in one editable file.
- **Embed mode:** with `?embed=1`, the app hides its own header and fits neatly in an iframe on alpineislands.com, with a "Open full screen" link. Check that GitHub Pages allows framing and that the map and touch controls work inside an iframe on phones.
- **Load forecasts by region.** All of BC's known zones would blow past Open-Meteo's limits in one page load. Fetch only the selected region (or the area in view), keep each load to about 200 points, and cache as the surf app does.

### 5e. Field reports

Adapt `reports.js` / `feedback.js`: snow surface (blower / powder / wind-affected / crust / corn / mank / breakable crust), depth of new snow, elevation and aspect actually ridden, and red flags seen (recent avalanches, cracking, whumpfing). Record the model's prediction alongside, as the surf app does. Point people to the Mountain Information Network to share avalanche observations with everyone.

### 5f. Removing areas (automatic exclusions + Steve's curation)

**Automatic, in the pipeline.** Remove zones that overlap:
- First Nations reserves (Canada) and tribal reservation and trust lands (US), unless access is explicitly public
- Specific sacred or cultural sites that a Nation publicly asks visitors to avoid. Most such sites are deliberately not mapped, so the pipeline can't catch them all; that's what Steve's curation is for. Never try to infer or reveal unmapped sites. (Widely toured mountains that are culturally significant stay in, with an acknowledgement: principle 11.)
- Ski resort operating boundaries, BC Controlled Recreation Areas, and commercial cat-ski and heli-ski tenures
- Closures such as wildlife and caribou closures, and areas where recreation is prohibited

Keep each exclusion source and its date in `snow/pipeline/exclusions/`, and list in the README what is excluded and why.

**Steve's curation ("comb through"):**
- Add a curation mode turned on by a URL flag (e.g. `?curate=1`) so regular testers don't see it. It adds a **"Remove this area"** button on each zone, plus a way to draw a box or polygon around a larger area to remove.
- Removals are saved on the device (like surf reports) and listed with **Email removal list** and **Download** buttons. Each removal can carry an optional private note, e.g. "sacred site" or "locals' stash".
- Removals are stored as **geographic shapes, not zone IDs** (IDs change when data is rebuilt). They go into `snow/pipeline/exclusions/curated.json`, and the pipeline drops those areas **for everyone** on the next rebuild. Hiding them only on Steve's phone isn't enough.
- Never publish the reason notes; they stay in the private list. Treat the curated list as sensitive. If Steve prefers it not to live in the public repo, keep only the shapes, with no notes.
- After a rebuild, report to Steve how many zones each removal took out.

### 5g. Alpine Islands page

Steve wants this connected to Alpine Islands now. Deliver a page he can paste into alpineislands.com (WordPress, Gutenberg editor):

- Look at alpineislands.com first to match its look (fonts, colours, tone). Give the app an Alpine Islands colour theme (e.g. `?theme=alpineislands`) so the embed feels native.
- If the session has the Alpine Islands skills (e.g. the destination-guide skill), load them and follow their Gutenberg block patterns, SEO and schema conventions.
- The page wraps the embedded app with:
  - a short intro (placeholder copy for Steve)
  - the safety notice
  - how to read the scores and the hazard panel
  - how to send a field report (and the Mountain Information Network link)
  - territory acknowledgement
  - links to the official avalanche centres and AST courses
- Deliver it as paste-ready Gutenberg markup in `snow/alpine-islands-page.html`, plus a plain-text version, with SEO title and description lines. Mark every piece of prose for Steve to rewrite.

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
| Usage ("known") | Strava Global Heatmap (check terms; likely not reusable); OSM ski-touring routes and public GPS traces; Mountain Information Network and US centre observation locations |
| Territory & acknowledgements | Native Land Digital (starting point only; has an API, check terms); each Nation's own website and published materials |
| Permits & daily closures | Parks Canada Rogers Pass winter permit system and restricted-area status; DriveBC / highway avalanche-control information (Kootenay Pass, Duffey, Coquihalla) |
| Access & trailheads | OpenStreetMap (roads, trailheads, winter parking, huts); BC Recreation Sites and Trails; USFS roads and trails |
| Motorized legality | USFS over-snow vehicle use maps (Okanogan-Wenatchee, Mt Baker-Snoqualmie, Colville and Idaho Panhandle national forests); Wilderness boundaries; National Park boundaries; BC snowmobile closures; Selkirk caribou closures (BC and Idaho) |
| Heli operators | Permitted operators and their permit or tenure areas (e.g. USFS permits in the North Cascades; BC commercial recreation tenures) |
| Exclusions | Canada Lands / Indian Reserve boundaries; US tribal land boundaries (Census or BIA); ski area boundaries (OSM `landuse=winter_sports`, USFS permits); BC Controlled Recreation Areas and commercial recreation tenures (BC Data Catalogue); published cultural or heritage sites |

**Network:** this cloud environment only reaches allowed hosts. When a request is refused by the proxy, use the environment tools to propose adding exactly the hosts needed. Don't work around the proxy.

## 7. Repo and code rules

- Same rules as the surf app (see `CLAUDE.md`): no-build static site, plain ES modules, Leaflet from jsDelivr with SRI hashes, relative URLs, generated data never hand-edited.
- Pure scoring functions with tests for every rule. Add `tests/snow/*.test.mjs` to `npm test` without breaking the surf tests.
- Keep forecast requests within Open-Meteo's limits (the surf app keeps ~200 points per load and caches for an hour). Mountain weather varies fast with elevation, so prefer requesting by elevation band per grid point over adding points. Load by region on demand (see 5d).
- Update `README.md` with a plain-language "Backcountry Snow Finder" section, and update `CLAUDE.md` with any rules future sessions need.
- Work on the `backcountry-snow` branch. Commit as you go, push the branch, and **don't merge to `main`** until Steve has tried it and says so.
- Open-Meteo's free tier is non-commercial. Flag this if Steve talks about monetizing.

## 8. Order of work (check in with Steve at each ★)

1. ★ Read section 9 (most questions are answered). Confirm the plan with Steve in a few lines before writing code.
2. Verify the data sources (section 6). ★ Report what's available, what's blocked and any terms issues.
3. Build the terrain pipeline for the iteration-1 areas, with automatic exclusions and travel times. ★ Show Steve a map of candidate zones coloured by use level, check the Spearhead Traverse vs. Wedge Creek contrast, and ask whether the zone boundaries, slope classes and travel times look right to someone who rides there.
4. Add curation mode so Steve can start combing through and removing areas while the rest gets built.
5. Avalanche forecast integration and hazard panel. ★ Check the wording and layout with Steve: this is the most safety-critical part.
6. Snow quality model + tests, checked against a recent storm cycle Steve remembers.
7. The app UI (with disclaimer and embed mode), caching, field reports, territory acknowledgements. ★ Steve reviews every acknowledgement before it goes live.
8. The Alpine Islands page (5g). ★ Steve rewrites the prose.
9. Phase 1b: known zones across the rest of BC. ★ Confirm the list with Steve.
10. ★ Hand over: what works, what's uncertain, how to test it, and suggested next steps.

The feedback address is set, so check-ins no longer need the email reminder.

## 9. Steve's answers so far, and what's left to ask

Already decided:
- **Areas:** Sea-to-Sky, North Cascades and the southern Selkirks on both sides of the border, with deep backcountry (phase 1); known zones across the rest of BC (phase 1b).
- **"Known":** from real usage data (heatmaps / tracks), not a hand-made list.
- **Travel times:** standard Munter method.
- **Testers:** Steve and Alpine Islands members, assumed avalanche-trained, with a disclaimer to accept first.
- **Culturally significant mountains:** stay in, with an acknowledgement drawn from the Nations' own public sources; walk gently and with respect.
- **Alpine Islands:** connect now, as a page on the site.
- **Curation:** Steve combs through and removes areas; automatic exclusions handle reserves, tenures, closures and sites Nations ask to be avoided.
- **Email address:** `Gnar-Data@proton.me`, for both the snow app and the surf app (set 2026-11-07). No more reminders needed.

Decided at the first check-in (2026-11-07):
- **Avalanche Canada:** build on the public API now. Steve gets written permission (he knows people there) before the app goes public. Until then show ratings, problems and a link, not the bulletin text.
- **Washington Selkirks:** left out (no avalanche centre forecasts them). Idaho Selkirks (IPAC) stay. The North Cascades stay.
- **Native Land Digital:** Steve signs up and agrees to the Data Sovereignty Treaty himself. Its terms forbid storing or redistributing the data without permission and charging for access (including paid memberships), so use it only to find which Nations to check; the territory names the app shows come from each Nation's own public sources.
- **Phase 1b list (final):** Coquihalla, Rogers Pass, the Rockies (Golden/Yoho, Fernie/Elk Valley, Robson/Valemount), Babine Mountains, Terrace, Stikine, Stewart, North Shore, Revelstoke, Kootenay Lake, Vancouver Island. Dease Lake dropped (no Avalanche Canada forecast area). Sea-to-Sky and the Duffey are already phase 1.
- **Open-Meteo:** if money ever changes hands, Steve will buy a commercial licence.
- **Disclaimer:** Steve's paragraph, then bullets for: AST 1 assumed, read the official bulletin first, what the model can't see.
- **Acknowledgement:** say what the Nations did (cared for these lands for a very long time), not what they didn't do, and ask visitors to treat the land like a relative. Steve reviews the final wording.

Decided at the zone-map check-in (2026-11-07):
- **Heli-ski tenures and proposed ski resorts:** keep them, highlight them on zones, don't exclude. Cat-ski tenures stay excluded.
- **Cultural areas:** flag them with why they're cultural and who to contact (`snow/content/cultural_areas.json`). Block areas documented as cultural use (Cultural Places). Cultural Management Areas are flagged. Joffre Lakes / Pipi7íyekw is an exception: it closes only part of the year, so it's flagged with the closure dates.

Decided after the AutoATES trial (2026-11-08):
- **AutoATES v2.0 replaces the homemade exposure rule** for the "approach exposed to avalanche terrain" flag and for route-finding (challenging terrain or worse counts as exposed). Steve reviewed the Spearhead trial map: "AutoATES looks good."
- **Each zone shows its AutoATES class mix**, clearly labelled as a model estimate and not an official ATES rating. Official ATES maps, where they exist, come first.

Decided 2026-11-10:
- **AutoATES scope:** Sea-to-Sky day-trip tiles only for now (done: 99% of day-trip zones). North Cascades and South Selkirks tiles wait; work stays on Sea-to-Sky.
- **Diamond Head:** the road is open to the lot, but chains are mandatory in winter. Added as a trailhead; routes starting there carry the chains note.
- **SR 20:** snowmobiling the closed highway is legal, so the closed section is a sled route.
- **Lillooet River Cultural Management Area:** name the Douglas and Skatin bands (added alongside Líl̓wat; Steve to confirm Líl̓wat stays and to supply contacts for Skatin, and a direct one for Douglas).

Decided 2026-11-11:
- **Small alpine pieces** join their neighbouring zone instead of being dropped (Steve spotted empty alpine around the Callaghan, Brandywine and Powder Mountain).
- **Gentle glaciers aren't zones**, but tapping one shows it's a glacier, with Steve's glacier note.
- **Lillooet River:** Líl̓wat stays. No direct contacts for Douglas and Skatin: the app says to consult their band office.
- **Next:** curation mode, then the hazard panel (built 2026-11-11; wording in `snow/content/hazard.json` waiting for Steve's rewrite).

Still to ask, when it comes up:
1. If the Strava heatmap's terms don't allow reuse: is the open-data usage estimate good enough, or should we approach Strava (e.g. Strava Metro) properly? - [STEVE'S ANSWER: open data usage is good enough for now]
2. The phase 1b list of BC regions, once the usage data suggests one. [STEVE's ANSWER: Sea to sky, duffey lake, coquihalla, rogers' pass, rocky mountains, babine mountains, terrace area, stikine, dease lake, stewart]
3. Steve's disclaimer and acknowledgement wording (he writes these). [Disclaimer: This is for informational purposes only. Use your educated judgment. Never rely on this info for decision making, use your brain and experience to make those. If you don't have either, find someone who does and pay them with time, money, or favours.] [These are sacred lands to the first nations. Don't be a dick. Show respect. They have been in charge of these lands for far longer than Western society so show some gratitude that they didn't trash it over 10,000 years.]

## 10. Definition of done for iteration 1

- Steve can open the app on his phone, see where the snow should be best today and this week in the chosen area, and see the official avalanche danger beside every score.
- Every score has a plain-language explanation, and the app states what it can't know.
- Tests pass. The surf app is unchanged and still works.
- Every zone shows estimated travel time by legal access mode, and travel-time filters work.
- Automatic exclusions are applied, and Steve can remove areas in curation mode and have them dropped for everyone on rebuild.
- Field reports work end to end.
- The disclaimer must be accepted before first use, every zone shows whose territory it's in, and every acknowledgement has been reviewed by Steve.
- Embed mode works in an iframe on a phone, and the Alpine Islands page is ready to paste.
- Every zone shows its use level (well-travelled / occasional / little sign of travel), and the Spearhead Traverse vs. Wedge Creek contrast comes through.
- The branch is pushed with a clear summary for Steve, ending with the email reminder if the address still isn't set.
