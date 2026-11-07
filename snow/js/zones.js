// Reading the zone data the pipeline writes (snow/data/zones-<region>.json).
//
// Pure functions only (no page, no network), so they can be tested: npm test

/**
 * Zone outline -> [[lat, lon], ...].
 * The pipeline stores outlines as whole-number steps of 0.0001 degrees,
 * [dlon, dlat, dlon, dlat, ...]: the first step from the zone centre `c`,
 * each later one from the previous point. Small numbers keep the file small.
 */
export function decodeRing(c, steps) {
  let x = Math.round(c[1] * 1e4);
  let y = Math.round(c[0] * 1e4);
  const out = [];
  for (let i = 0; i + 1 < steps.length; i += 2) {
    x += steps[i];
    y += steps[i + 1];
    out.push([y / 1e4, x / 1e4]);
  }
  return out;
}

// --- Travel time (Munter method) -----------------------------------------
//
// 1 "unit" = 1 km of distance or 100 m of climbing. An average touring party
// manages about 4 units an hour uphill. The pipeline's times assume that rate;
// people can set their own pace, and times are rescaled here.

export const MUNTER_DEFAULT = 4;

/** Munter time in hours for a leg: km of travel, metres climbed, units per hour. */
export function munterHours(km, climbM, rate = MUNTER_DEFAULT) {
  if (!(rate > 0)) return Infinity;
  return (Math.max(0, km) + Math.max(0, climbM) / 100) / rate;
}

/**
 * Rescale a pipeline time to a different skinning pace.
 * Only the skinning part changes; sled legs and lift rides stay as they are.
 *   total = fixed part (sled / lift) + skinning part at the default rate
 */
export function rescaleHours(totalH, fixedH, rate = MUNTER_DEFAULT) {
  const skinning = Math.max(0, totalH - (fixedH || 0));
  return (fixedH || 0) + skinning * (MUNTER_DEFAULT / rate);
}

/** "2 h 30 min" style, rounded to the nearest quarter hour. */
export function fmtHours(h) {
  if (!Number.isFinite(h)) return "unknown";
  const q = Math.max(0.25, Math.round(h * 4) / 4);
  const hh = Math.floor(q);
  const mm = Math.round((q - hh) * 60);
  if (hh === 0) return `${mm} min`;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

/**
 * One-line description of how you get there, e.g. "Sled 22 km, ~1 h · skin 4 km and 900 m up, ~2 h 30 min".
 * For lift access, `rideH` is the lift ride from the base (from the region's gate list).
 */
export function accessSummary(mode, a, rideH = 0) {
  if (!a) return "";
  const fixed = mode === "sled" ? a.sledH || 0 : mode === "lift" ? rideH : 0;
  const skin = `skin ${a.km} km and ${a.up} m up, ~${fmtHours(a.h - fixed)}`;
  if (mode === "sled") return `Sled ${a.sledKm} km, ~${fmtHours(a.sledH)} · ${skin}`;
  if (mode === "lift") return `Lifts (~${fmtHours(rideH)}), then ${skin}. Lift ticket and resort rules apply.`;
  return skin.charAt(0).toUpperCase() + skin.slice(1);
}

export const USE_LABELS = ["little sign of travel", "occasional", "well-travelled"];
export const BAND_LABELS = ["Below treeline", "Treeline", "Alpine"];
export const SLOPE_CLASSES = ["under 30°", "30–35°", "35–45°", "over 45°"];
