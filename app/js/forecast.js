// Fetches swell (Open-Meteo Marine) and wind (Open-Meteo Forecast) for every
// forecast point, in batches. Both APIs are free for non-commercial use and need no key.
// Each location counts as one call against Open-Meteo's limit (600 per minute),
// so the pipeline groups spots to keep the number of points around 200.

const MARINE = "https://marine-api.open-meteo.com/v1/marine";
const WEATHER = "https://api.open-meteo.com/v1/forecast";
const BATCH = 100;
const DAYS = 7;

const MARINE_VARS = [
  "swell_wave_height", "swell_wave_period", "swell_wave_direction",
  "secondary_swell_wave_height", "secondary_swell_wave_period", "secondary_swell_wave_direction",
  "wind_wave_height", "wind_wave_period", "wind_wave_direction",
];
const WIND_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"];

async function getJSON(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let reason = "";
        try { reason = (await res.json()).reason || ""; } catch { /* ignore */ }
        const err = new Error(`HTTP ${res.status} ${reason}`.trim());
        err.retry = res.status === 429 || res.status >= 500;
        throw err;
      }
      return await res.json();
    } catch (err) {
      // network hiccups and rate limits get a couple of retries, with a pause
      if (attempt >= tries || err.retry === false) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Remembering the forecast between page loads
//
// Forecast models only update every few hours, so there's no point downloading
// ~200 locations again on every reload (and doing so trips Open-Meteo's per-minute
// limit). Responses are kept in the browser's Cache Storage, which has plenty of
// room, rather than localStorage, which is small and holds people's surf reports.
// ---------------------------------------------------------------------------

const CACHE_NAME = "surf-forecast-v1";
export const FRESH_MS = 60 * 60 * 1000;      // reuse a saved forecast for up to an hour
export const STALE_MS = 12 * 60 * 60 * 1000; // if a refresh fails, fall back to one up to 12 h old

async function openCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    // tidy up: drop anything too old to ever be used again
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res || Date.now() - Number(res.headers.get("x-saved-at")) > STALE_MS) await cache.delete(req);
    }
    return cache;
  } catch {
    return null; // no Cache Storage (old browser, private mode): just fetch every time
  }
}

async function readSaved(cache, url) {
  if (!cache) return null;
  try {
    const res = await cache.match(url);
    if (!res) return null;
    return { at: Number(res.headers.get("x-saved-at")), data: await res.json() };
  } catch {
    return null;
  }
}

/** Fetch JSON, using a saved copy when it's fresh, or when it's stale but the network fails. */
async function cachedJSON(cache, url) {
  const saved = await readSaved(cache, url);
  if (saved && Date.now() - saved.at < FRESH_MS) return { ...saved, source: "saved" };
  try {
    const data = await getJSON(url);
    const at = Date.now();
    if (cache) {
      try {
        await cache.put(url, new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json", "x-saved-at": String(at) },
        }));
      } catch { /* storage full or blocked: carry on without saving */ }
    }
    return { data, at, source: "network" };
  } catch (err) {
    if (saved && Date.now() - saved.at < STALE_MS) return { ...saved, source: "stale" };
    throw err;
  }
}

function buildUrl(base, points, vars, extra) {
  const lat = points.map((p) => p[0]).join(",");
  const lon = points.map((p) => p[1]).join(",");
  return `${base}?latitude=${lat}&longitude=${lon}&hourly=${vars.join(",")}` +
    `&forecast_days=${DAYS}&timeformat=unixtime&timezone=GMT${extra}`;
}

/**
 * Returns { times: [unix seconds...], points: [ {marine, wind} per forecast point ],
 *           fetchedAt (ms, when the oldest piece was downloaded), stale (true if a refresh failed) }
 * where marine/wind are Open-Meteo "hourly" objects (arrays per variable).
 */
export async function fetchForecasts(points, onProgress = () => {}) {
  const out = new Array(points.length);
  let times = null;
  const batches = [];
  for (let i = 0; i < points.length; i += BATCH) batches.push([i, points.slice(i, i + BATCH)]);

  const cache = await openCache();
  let fetchedAt = Date.now();
  let stale = false;
  let done = 0;
  for (const [start, chunk] of batches) {
    const results = await Promise.all([
      cachedJSON(cache, buildUrl(MARINE, chunk, MARINE_VARS, "&cell_selection=sea")),
      cachedJSON(cache, buildUrl(WEATHER, chunk, WIND_VARS, "&wind_speed_unit=kn&cell_selection=nearest")),
    ]);
    for (const r of results) {
      fetchedAt = Math.min(fetchedAt, r.at);
      if (r.source === "stale") stale = true;
    }
    const [marine, wind] = results.map((r) => r.data);
    const m = Array.isArray(marine) ? marine : [marine];
    const w = Array.isArray(wind) ? wind : [wind];
    m.forEach((loc, k) => {
      out[start + k] = { marine: loc.hourly, wind: w[k]?.hourly };
      if (!times) times = loc.hourly.time;
    });
    done += chunk.length;
    onProgress(done / points.length);
  }
  return { times, points: out, fetchedAt, stale };
}

/** Pull out the conditions at one forecast point and hour, in the shape scoring.js expects. */
export function conditionsAt(fp, hourIdx) {
  if (!fp || !fp.marine) return null;
  const m = fp.marine;
  const w = fp.wind || {};
  const pick = (k) => (m[k] ? m[k][hourIdx] : null);
  const swells = [
    { h: pick("swell_wave_height"), t: pick("swell_wave_period"), dir: pick("swell_wave_direction") },
    { h: pick("secondary_swell_wave_height"), t: pick("secondary_swell_wave_period"), dir: pick("secondary_swell_wave_direction") },
  ].filter((s) => s.h != null && s.h > 0.05);
  if (pick("swell_wave_height") == null && pick("wind_wave_height") == null) return null; // no model data here
  return {
    swells,
    windWave: { h: pick("wind_wave_height"), t: pick("wind_wave_period"), dir: pick("wind_wave_direction") },
    windKn: w.wind_speed_10m ? w.wind_speed_10m[hourIdx] : null,
    windDir: w.wind_direction_10m ? w.wind_direction_10m[hourIdx] : null,
    gustKn: w.wind_gusts_10m ? w.wind_gusts_10m[hourIdx] : null,
  };
}
