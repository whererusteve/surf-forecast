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

function buildUrl(base, points, vars, extra) {
  const lat = points.map((p) => p[0]).join(",");
  const lon = points.map((p) => p[1]).join(",");
  return `${base}?latitude=${lat}&longitude=${lon}&hourly=${vars.join(",")}` +
    `&forecast_days=${DAYS}&timeformat=unixtime&timezone=GMT${extra}`;
}

/**
 * Returns { times: [unix seconds...], points: [ {marine, wind} per forecast point ] }
 * where marine/wind are Open-Meteo "hourly" objects (arrays per variable).
 */
export async function fetchForecasts(points, onProgress = () => {}) {
  const out = new Array(points.length);
  let times = null;
  const batches = [];
  for (let i = 0; i < points.length; i += BATCH) batches.push([i, points.slice(i, i + BATCH)]);

  let done = 0;
  for (const [start, chunk] of batches) {
    const [marine, wind] = await Promise.all([
      getJSON(buildUrl(MARINE, chunk, MARINE_VARS, "&cell_selection=sea")),
      getJSON(buildUrl(WEATHER, chunk, WIND_VARS, "&wind_speed_unit=kn&cell_selection=nearest")),
    ]);
    const m = Array.isArray(marine) ? marine : [marine];
    const w = Array.isArray(wind) ? wind : [wind];
    m.forEach((loc, k) => {
      out[start + k] = { marine: loc.hourly, wind: w[k]?.hourly };
      if (!times) times = loc.hourly.time;
    });
    done += chunk.length;
    onProgress(done / points.length);
  }
  return { times, points: out, fetchedAt: Date.now() };
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
