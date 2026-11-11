// Fetching the official avalanche forecast for a zone, with a small on-device cache.
//
// BC (north of 49°): Avalanche Canada's public API, forecast for the zone's point.
// Washington and Idaho: avalanche.org's map layer (NWAC, IPAC), the zone's forecast area.
// Saved in Cache Storage for an hour; if a refresh fails, a saved copy up to 12 h old is
// used and the panel says how old it is. Older than that: no forecast is shown at all.

import { fromAvCan, fromAvalancheOrg, pointInGeometry } from "./hazard.js";

const CACHE_NAME = "snow-avalanche-v1";
export const FRESH_MS = 60 * 60 * 1000;
export const STALE_MS = 12 * 60 * 60 * 1000;
const AVCAN = "https://api.avalanche.ca/forecasts/en/products/point";
const AORG = "https://api.avalanche.org/v2/public/products/map-layer";
const BORDER_LAT = 49.0;

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch { return null; }   // private mode, old browsers
}

async function getJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** { data, at, source: "network" | "saved" | "stale" } */
async function cachedJSON(url) {
  const cache = await openCache();
  let saved = null;
  if (cache) {
    const res = await cache.match(url);
    if (res) saved = { data: await res.json(), at: Number(res.headers.get("x-saved-at")) };
  }
  if (saved && Date.now() - saved.at < FRESH_MS) return { ...saved, source: "saved" };
  try {
    const data = await getJSON(url);
    const at = Date.now();
    if (cache) {
      await cache.put(url, new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json", "x-saved-at": String(at) },
      })).catch(() => {});
    }
    return { data, at, source: "network" };
  } catch (err) {
    if (saved && Date.now() - saved.at < STALE_MS) return { ...saved, source: "stale" };
    throw err;
  }
}

/**
 * The official forecast for a zone centre [lat, lon].
 * Returns { forecast, at, source } or { forecast: null, reason } when no centre covers it.
 * Throws if the forecast can't be loaded (the panel then says so and links out).
 */
export async function forecastFor(lat, lon) {
  if (lat >= BORDER_LAT) {
    const url = `${AVCAN}?lat=${lat.toFixed(3)}&long=${lon.toFixed(3)}`;
    const r = await cachedJSON(url);
    if (!r.data || !r.data.report) return { forecast: null, reason: "none", at: r.at, source: r.source };
    return { forecast: fromAvCan(r.data), at: r.at, source: r.source };
  }
  const r = await cachedJSON(AORG);
  const feat = (r.data.features || []).find((f) => pointInGeometry(lon, lat, f.geometry));
  if (!feat) return { forecast: null, reason: "none", at: r.at, source: r.source };
  return { forecast: fromAvalancheOrg(feat.properties), at: r.at, source: r.source };
}
