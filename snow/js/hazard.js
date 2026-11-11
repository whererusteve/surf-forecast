// Reading the official avalanche forecasts. Pure functions only (no page, no network),
// so they can be tested: npm test
//
// Safety rules (brief, section 3): the official forecast is the authority; the app never
// makes its own danger rating; danger is shown beside snow quality, never blended into it.
// Until Avalanche Canada gives written permission, we show ratings, problems and a link,
// never their bulletin text (Steve's decision, 2026-11-07).

/** North American danger scale. Index = level (0 = no rating). Colours are the standard ones. */
export const DANGER_NAMES = ["No rating", "Low", "Moderate", "Considerable", "High", "Extreme"];
export const DANGER_COL = ["#d0d0d0", "#52ba4a", "#fff300", "#f79218", "#ef1c29", "#1a1a1a"];
const LEVEL = { low: 1, moderate: 2, considerable: 3, high: 4, extreme: 5 };

/** Zone band (0 below treeline, 1 treeline, 2 alpine) -> forecast key. */
export const BAND_KEYS = ["btl", "tln", "alp"];

/** "considerable" -> 3; "earlyseason", "norating", unknown -> 0. Numbers (avalanche.org) pass through. */
export function dangerLevel(v) {
  if (typeof v === "number") return v >= 1 && v <= 5 ? Math.round(v) : 0;
  return LEVEL[String(v || "").toLowerCase()] || 0;
}

/** "3 - Considerable" style label. */
export function dangerLabel(level) {
  return level ? `${level} - ${DANGER_NAMES[level]}` : DANGER_NAMES[0];
}

/**
 * An Avalanche Canada product (from /forecasts/en/products/point) in a plain shape:
 * { source, url, issued, validUntil, days: [{ label, ratings: {alp, tln, btl}: {level, text} }],
 *   problems: [...], earlySeason }
 */
export function fromAvCan(product) {
  const r = (product && product.report) || {};
  const days = (r.dangerRatings || []).map((d) => {
    const ratings = {};
    for (const k of BAND_KEYS) {
      const raw = d.ratings && d.ratings[k] && d.ratings[k].rating;
      ratings[k] = { level: dangerLevel(raw && raw.value), value: raw ? raw.value : "", text: raw ? raw.display : "" };
    }
    return { label: (d.date && d.date.display) || "", date: d.date && d.date.value, ratings };
  });
  const problems = (r.problems || []).map((p) => {
    const d = p.data || {};
    const size = d.expectedSize || {};
    return {
      type: (p.type && p.type.display) || "Avalanche problem",
      elevations: (d.elevations || []).map((e) => e.value),
      elevationNames: (d.elevations || []).map((e) => e.display),
      aspects: (d.aspects || []).map((a) => a.value),
      likelihood: (d.likelihood && d.likelihood.display) || "",
      size: [Number(size.min) || null, Number(size.max) || null],
    };
  });
  const values = days.flatMap((d) => BAND_KEYS.map((k) => d.ratings[k].value));
  return {
    kind: "bands",
    source: r.forecaster || "Avalanche Canada",
    url: product && product.url,
    issued: r.dateIssued || null,
    validUntil: r.validUntil || null,
    days,
    problems,
    earlySeason: values.length > 0 && values.every((v) => v === "earlyseason" || v === "norating"),
  };
}

/** An avalanche.org map-layer feature's properties (NWAC, IPAC): only the zone's highest danger. */
export function fromAvalancheOrg(props) {
  const p = props || {};
  const level = dangerLevel(p.danger_level);
  return {
    kind: "overall",
    source: p.center_id === "NWAC" ? "Northwest Avalanche Center (NWAC)"
      : p.center_id === "IPAC" ? "Idaho Panhandle Avalanche Center (IPAC)" : (p.center_id || "Avalanche center"),
    zoneName: p.name || "",
    url: p.link || null,
    issued: p.start_date || null,
    validUntil: p.end_date || null,
    overall: { level, text: level ? DANGER_NAMES[level] : (p.danger || "no rating") },
    offSeason: !!p.off_season,
    earlySeason: !level,
    days: [],
    problems: [],
  };
}

/** "current" or "expired" (also "unknown" when the forecast doesn't say). */
export function forecastStatus(f, now = new Date()) {
  if (!f || !f.validUntil) return "unknown";
  const until = new Date(f.validUntil);
  if (Number.isNaN(until.getTime())) return "unknown";
  return now > until ? "expired" : "current";
}

/** Problems that apply to the zone's elevation band, each noting whether its aspects include the zone's. */
export function problemsForZone(f, band, aspect) {
  const key = BAND_KEYS[band];
  const asp = String(aspect || "").toLowerCase();
  return (f.problems || []).map((p) => ({
    ...p,
    inBand: p.elevations.length === 0 || p.elevations.includes(key),
    aspectMatch: !!asp && p.aspects.includes(asp),
  }));
}

/** The zone band's rating on the first forecast day (what the caution message is based on). */
export function zoneLevel(f, band) {
  if (f.kind === "overall") return f.overall.level;
  const d = f.days[0];
  return d ? d.ratings[BAND_KEYS[band]].level : 0;
}

/** At Considerable (3) or higher, the UI promotes lower-consequence terrain (principle 4). */
export function needsCaution(level) {
  return level >= 3;
}

/** Fill {placeholders} in Steve's wording. Unknown placeholders are left as they are. */
export function fill(text, vars) {
  return String(text || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/** Is [lon, lat] inside a GeoJSON Polygon or MultiPolygon (holes respected)? */
export function pointInGeometry(lon, lat, geom) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPoly = (rings) => inRing(rings[0]) && !rings.slice(1).some(inRing);
  if (!geom) return false;
  if (geom.type === "Polygon") return inPoly(geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some(inPoly);
  return false;
}
