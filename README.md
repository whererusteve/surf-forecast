# PNW Surf Finder

Finds where the Pacific Northwest coast is lighting up right now, including stretches of coast nobody has put on a surf map yet.

It reads seafloor depth data for the whole coast from the Columbia River to the Alaska border, works out where swell can physically reach and how it would break, then scores more than 5,000 candidate spots hour by hour against live swell, wind and tide forecasts.

## How it finds spots

The discovery work happens once, offline, in `pipeline/build_spots.py`:

1. **Map the coast.** Load NOAA's ETOPO 2022 depth grid (one value every ~450 m) and trace every cell where sea meets land. Lakes are dropped by keeping only water connected to the open Pacific.
2. **Find the swell window.** From each stretch of coast, cast 72 rays out to sea, one every 5°. A ray that reaches open ocean without crossing more than ~1 km of land is open: swell from that direction can arrive. Swell that has to cross kilometres of bars or tidal flats counts as blocked, because it breaks and dies first. The result is each spot's *swell window*. For example, Jordan River only opens to 265–290°, straight down the Strait of Juan de Fuca.
3. **Read the seafloor.** Record which way the coast faces, the depth profile straight out to 8 km, whether the spot is a headland/point, cove, islet or straight coast, and whether an offshore ridge could focus swell onto it.
4. **Rate the geography.** Combine those into a 0–1 *potential*, and tag any candidate within 3 km of a well-known break as "known". The rest are unexplored.

The output is `app/data/spots.json`.

## How it scores conditions

The web app (`app/`) fetches a 7-day forecast and scores every spot for every hour (`app/js/scoring.js`):

| Factor | What it means |
|---|---|
| **Exposure** | Is the swell coming from inside this spot's window? |
| **Wave size** | Offshore swell height, reduced for angle and shelter, converted to breaking face height (Komar & Gaillard formula: long-period swell breaks bigger). Scored against your chosen size: small, fun, overhead or big. |
| **Period** | Longer period means more organised, more powerful waves. |
| **Wind** | Offshore or light is good. Onshore is bad. Gale-force is bad from any direction. |
| **Cleanliness** | How much local wind chop is mixed in. |
| **Geography** | The spot's potential from the pipeline. |

Each factor runs from 0 to 1, and they multiply together: any one bad factor pulls the score down. "Best this week" mode ranks spots by their best *daylight* hour over the next 7 days.

Tides are shown for the selected spot's nearest station, with a guess at which tide the seafloor shape prefers. Tide isn't part of the score yet (see the roadmap).

## Surf reports (real-world testing)

Every spot has a **Report what you saw** button at the bottom. The form asks whether there's a wave there at all, its size, quality, surface, bottom type and crowd, plus notes. The app automatically records what it predicted for that place and time (score, wave size, swell, wind, tide) next to the answers, so the two can be compared.

- Reports are saved in the tester's browser and listed under **Your surf reports** at the bottom of the panel.
- **Email** opens a pre-written email, which the tester can read before sending. The last line of each email is a machine-readable copy of the report, for analysis.
- **Download spreadsheet** exports every report on that device as a CSV file.
- The receiving address is set in `app/js/config.js` (`FEEDBACK_EMAIL`). Anyone can read it in the site's code, so use an address made for this. While it's empty, emails open with a blank "To" line.
- When the scoring model changes meaningfully, bump `MODEL_VERSION` in the same file so we know which version each report was testing.

## Run it on your computer

You need [Python 3](https://www.python.org/downloads/) (to serve the files) and a web browser.

```bash
npm run serve
```

Then open http://localhost:8000. No `npm install` needed: `npm run serve` just runs Python's built-in web server.

> **Why a server and not just double-clicking `index.html`?** Browsers block pages opened straight from disk from loading other local files (like `spots.json`). A tiny local web server avoids that.

## Rebuild the spot data

Only needed after changing the pipeline or `pipeline/known_spots.json`:

```bash
pip install -r pipeline/requirements.txt
```

```bash
python pipeline/build_spots.py
```

The first run downloads ~24 MB of depth data into `pipeline/cache/`, which isn't committed to git. A full run takes about 15 seconds.

## Run the tests

```bash
npm test
```

The tests check the scoring rules: offshore beats onshore wind, blocked swell scores near zero, and so on. Run them after changing `scoring.js`.

## Put it online (GitHub Pages)

The site is live at **https://whererusteve.github.io/surf-forecast/**. GitHub Pages publishes it straight from the `main` branch (Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`). The small `index.html` at the top of the repo forwards visitors into `app/`, where the real app lives. Every push to `main` updates the site within a couple of minutes.

## What's where

```
app/                      the website (plain HTML/CSS/JS, no build step)
  index.html              page layout
  css/style.css           look and feel (colours are set at the top)
  js/main.js              loads data, draws the map and ranked list, handles controls
  js/scoring.js           the surf scoring model (pure functions, tested)
  js/detail.js            spot detail panel and its charts
  js/forecast.js          fetches swell + wind from Open-Meteo
  js/tides.js             fetches tides from DFO (BC) and NOAA (WA)
  js/sun.js               daylight calculation
  js/reports.js           surf report format, email text and spreadsheet export (tested)
  js/feedback.js          surf report form and "Your surf reports" list
  js/config.js            feedback email address and model version
  data/spots.json         generated by the pipeline; don't edit by hand
pipeline/
  build_spots.py          the discovery pipeline
  known_spots.json        well-known breaks (edit freely, then rebuild)
tests/                    automated tests for the scoring model
```

## Data sources

- **Swell and wind:** [Open-Meteo](https://open-meteo.com/) Marine and Forecast APIs. Free for **non-commercial** use (CC BY 4.0). Monetizing the app would need an [Open-Meteo API subscription](https://open-meteo.com/en/pricing).
- **Depth:** [NOAA ETOPO 2022](https://www.ncei.noaa.gov/products/etopo-global-relief-model), 15 arc-second, via NOAA CoastWatch ERDDAP. Public domain.
- **Tides:** [Fisheries and Oceans Canada IWLS](https://api-iwls.dfo-mpo.gc.ca/) for BC, [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/) for Washington.
- **Imagery:** Esri World Imagery and Ocean basemaps.

## Known limitations

- **It's a model, not a surf report.** A ~450 m depth grid can't see individual reefs, boulders or sandbars, which is exactly what makes or breaks a wave. Treat high scores as "worth a look on satellite", not "it's on".
- **Coastline accuracy varies.** On the open Washington coast the dots sit right on the beach. In parts of BC's more intricate coast (e.g. north of Vargas Island), the depth grid's coastline is coarser than the satellite imagery, so some dots sit a few hundred metres offshore.
- **Big rivers.** The Columbia's dredged shipping channel lets a few estuary spots score higher than they should.
- **Forecast resolution and freshness.** Spots within ~20 km share one offshore forecast, which keeps the free API happy (about 200 points, under Open-Meteo's 600-calls-per-minute limit). Each browser saves the forecast and reuses it for up to an hour, so reloads are instant and don't hit the limit. If a refresh fails, the app shows the last saved forecast (up to 12 hours old) and says so.

## Roadmap ideas

1. **Sharper coastline:** snap spots to a high-resolution shoreline (GSHHG or OpenStreetMap).
2. **Wave refraction modelling:** trace swell rays over the seafloor for each swell direction and period to find where energy focuses. This is what makes famous big-wave spots big.
3. **Satellite classification:** use Sentinel-2 imagery to tell sand beaches from rock reefs and see visible whitewater on big days.
4. **Tide in the score:** learn each spot's tide preference, starting with feedback from people who surf it.
5. **Calibrate from surf reports:** once reports come in, compare predictions with what people saw and tune the scoring.
6. **Scale up:** Oregon and California next. The pipeline is driven by a bounding box, so expanding is mostly a matter of compute. At larger scale, a scheduled job should fetch forecasts once for everyone instead of each browser doing it.

## Surf respectfully

Much of this coast is the territory of First Nations, including reserve land and places that need permission to visit (Makah lands around Neah Bay need a recreation permit, for example). Find out whose land you're on before you go. Many candidates are hours from help, in cold water with no cell service: go with a partner, carry communication, and tell someone your plan. And think twice before posting exact coordinates of a fragile spot.

## Backcountry Snow Finder (in progress, `snow/`)

A companion to the surf app for mountains: it uses weather forecasts and terrain
data to suggest where the snow should be good, always beside the official avalanche
danger rating, never blended with it. Built for Alpine Islands members, who are
assumed to be avalanche-trained.

What exists so far:

- **Zone preview** (`snow/index.html`): a view-only map of the zones, with travel time,
  use level, slope mix, wind exposure and the areas to respect. No forecasts yet. Steve's
  disclaimer (`snow/content/disclaimer.json`) must be accepted first.

- **Zone discovery** (`snow/pipeline/build_zones.py`): cuts the terrain of
  Sea-to-Sky, the North Cascades and the southern Selkirks into zones (one
  elevation band and aspect each) and works out each zone's slope-angle mix,
  forest cover, which winds load or scour it, estimated travel time by legal
  access mode (Munter method for skinning), and how much it is travelled
  according to open data.
- **What is left out and why:** `snow/pipeline/exclusions/README.md`.
- **Data sources and their terms:** `snow/SOURCES.md`.

Still to come: the avalanche forecast panel, the snow quality model, the app
itself, field reports, curation mode and the Alpine Islands page.
