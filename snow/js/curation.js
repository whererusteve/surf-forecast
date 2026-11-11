// Curation: Steve's list of areas to remove from the app for everyone.
//
// Pure functions only (no page, no storage), so they can be tested: npm test
//
// A removal is a SHAPE, not a zone ID, because zone IDs change on every rebuild.
// The private note stays in Steve's own list (device + his email). The file for the
// pipeline (snow/pipeline/exclusions/curated.json) gets shapes only, never notes.

/** Round to 5 decimals (~1 m), enough for a hand-drawn or zone outline. */
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Drop points that barely change the outline (Ramer-Douglas-Peucker).
 * `ring` is [[lon, lat], ...] without the closing point; `tol` is in degrees of latitude.
 */
export function simplifyRing(ring, tol = 0.0003) {
  if (ring.length <= 4) return ring.slice();
  const kx = Math.cos((ring[0][1] * Math.PI) / 180);   // longitude degrees are shorter
  const dist = (p, a, b) => {
    const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const keep = new Array(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = dist(ring[k], ring[i], ring[j]);
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > tol) { keep[at] = true; stack.push([i, at], [at, j]); }
  }
  const out = ring.filter((_, k) => keep[k]);
  return out.length >= 3 ? out : ring.slice(0, 3);
}

/**
 * Map outline ([[lat, lon], ...], as Leaflet and decodeRing give it) -> GeoJSON Polygon,
 * simplified, rounded and closed. Returns null for fewer than 3 points.
 */
export function toGeometry(latlngs, tol = 0.0003) {
  const pts = latlngs.map(([lat, lon]) => [r5(lon), r5(lat)]);
  if (pts.length && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
  if (pts.length < 3) return null;
  const ring = simplifyRing(pts, tol);
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

/** Rough area of a GeoJSON Polygon in km² (fine for showing "about 1.2 km²"). */
export function areaKm2(geometry) {
  const ring = geometry.coordinates[0];
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * Math.PI / 180;
  const kx = 111.32 * Math.cos(lat0), ky = 110.57;
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    a += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  }
  return Math.abs(a) / 2;
}

/** A new removal record for Steve's private list. */
export function newRemoval({ geometry, note = "", region, source, now = new Date(), id }) {
  return {
    id: id || `R-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    added: now.toISOString(),
    region,
    source,                  // e.g. "zone S-0123 (Metal Dome)" or "drawn"
    note: note.trim(),       // private
    geometry,
  };
}

/**
 * The file for the pipeline: the current curated.json plus this device's removals,
 * shapes only (no notes, no zone names). Removals already in the file are not repeated.
 */
export function pipelineFile(current, removals) {
  const base = current && Array.isArray(current.shapes) ? current : { version: 1, shapes: [] };
  const have = new Set(base.shapes.map((s) => s.id).filter(Boolean));
  const added = removals.filter((r) => !have.has(r.id))
    .map((r) => ({ id: r.id, added: r.added.slice(0, 10), region: r.region, geometry: r.geometry }));
  return { ...base, shapes: [...base.shapes, ...added] };
}

/** Plain-text email listing the removals, notes included (it goes to Steve's own inbox). */
export function removalsBody(list) {
  const lines = list.map((r, i) => {
    const c = centre(r.geometry);
    return `${i + 1}. ${r.added.slice(0, 10)} · ${r.region} · ${r.source}\n` +
      `   About ${areaKm2(r.geometry).toFixed(2)} km², centred ${c[1].toFixed(4)}, ${c[0].toFixed(4)}\n` +
      `   Note: ${r.note || "(none)"}`;
  });
  return `Snow Finder removal list (${list.length})\n\n${lines.join("\n\n")}\n\n` +
    "The notes are private: only the shapes go into the pipeline.\n\n" +
    `DATA ${JSON.stringify(list)}`;
}

/** mailto: link for the list, or null if it's too long for email apps (then use Download). */
export function mailtoUrl(email, list, maxLength = 7500) {
  const subject = `Snow Finder removals (${list.length})`;
  const url = `mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(removalsBody(list))}`;
  return url.length <= maxLength ? url : null;
}

/** Average of a polygon's points, [lon, lat]. */
export function centre(geometry) {
  const ring = geometry.coordinates[0].slice(0, -1);
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
}
