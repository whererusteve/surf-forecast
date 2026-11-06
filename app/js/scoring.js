// Scoring model: turns an offshore forecast + a spot's geography into a 0-10 score.
//
// Every function here is "pure" (same input -> same output, no network, no page),
// so it can be tested on its own:  npm test
//
// Directions are compass bearings in degrees. Swell and wind directions are the
// direction they come FROM (meteorological convention, same as Open-Meteo).
// A spot's `facing` is the direction you look when standing on the beach facing the sea.

const G = 9.81;

export const SIZE_PRESETS = {
  // breaking wave face height in metres: [too small, ideal from, ideal to, too big]
  small: [0.3, 0.6, 1.2, 2.0],
  fun: [0.5, 0.9, 1.8, 3.0],
  overhead: [0.8, 1.5, 2.8, 4.5],
  big: [1.5, 2.5, 5.0, 8.0],
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Smallest angle between two bearings, 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

/** "f3c0..." hex string from the pipeline -> array of 0/1 per 5-degree bin (bin 0 = north). */
export function unpackWindow(hex) {
  const bits = [];
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    for (let k = 3; k >= 0; k--) bits.push((v >> k) & 1);
  }
  return bits;
}

/**
 * How exposed the spot is to swell from `dir`, 0..1.
 * Swell spreads a little (and wraps around small obstacles), so we blend the
 * bins within +/-15 degrees instead of using a hard on/off edge.
 */
export function exposureAt(bits, dir, binDeg = 5) {
  const n = bits.length;
  let sum = 0;
  let wsum = 0;
  for (let off = -15; off <= 15; off += binDeg) {
    const w = 1 - Math.abs(off) / 20; // triangular weights: 1 at centre, 0.25 at edges
    const idx = ((Math.round((dir + off) / binDeg) % n) + n) % n;
    sum += w * bits[idx];
    wsum += w;
  }
  return sum / wsum;
}

/** Turn the window bits into readable ranges, e.g. "160–300°". */
export function windowRanges(bits, binDeg = 5) {
  const n = bits.length;
  if (bits.every((b) => b)) return ["all directions"];
  // start scanning from a closed bin so ranges don't get split at north
  const start = bits.findIndex((b) => !b);
  const out = [];
  let runStart = null;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (bits[i] && runStart === null) runStart = i;
    if (!bits[i] && runStart !== null) {
      const last = (i - 1 + n) % n;
      out.push(runStart === last ? `${runStart * binDeg}°` : `${runStart * binDeg}–${last * binDeg}°`);
      runStart = null;
    }
  }
  return out;
}

export function compass(deg) {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// ---------------------------------------------------------------------------
// Wave physics (deliberately simple and explainable)
// ---------------------------------------------------------------------------

/**
 * Breaking wave height from deep-water height H0 (m) and period T (s).
 * Komar & Gaillard (1973): Hb = 0.39 * g^0.2 * (T * H0^2)^0.4
 * Captures the key surf rule: long-period swell breaks much bigger than its
 * offshore height suggests.
 */
export function breakingHeight(H0, T) {
  if (!(H0 > 0) || !(T > 0)) return 0;
  return 0.39 * Math.pow(G, 0.2) * Math.pow(T * H0 * H0, 0.4);
}

/**
 * What one swell train does at a spot.
 * Returns { height (m, breaking face), exposure, angle, focus }.
 */
export function swellAtSpot(spot, bits, swell, binDeg = 5) {
  const { h, t, dir } = swell;
  if (!(h > 0) || !(t > 0) || dir == null) return { height: 0, exposure: 0, angle: 180, focus: 1 };
  const exposure = exposureAt(bits, dir, binDeg);
  const angle = angleDiff(dir, spot.facing);
  // Swell arriving at an angle spreads out as it bends towards shore (refraction)
  const obliquity = angle >= 90 ? 0.25 : Math.max(0.25, Math.sqrt(Math.cos((angle * Math.PI) / 180)));
  // Points and offshore ridges concentrate swell; very wide shallow shelves drain it
  let focus = 1 + 0.15 * (spot.ridge || 0);
  if (spot.type === "point") focus += 0.05;
  if (spot.profile && spot.profile[4] < 6) focus *= 0.85;
  // Swell that has to cross bars, estuaries or long shallow flats loses height on the way
  const shelf = spot.shelf ?? 1;
  const H = h * exposure * obliquity * focus * shelf;
  return { height: breakingHeight(H, t), exposure, angle, focus };
}

// ---------------------------------------------------------------------------
// Individual quality factors, each 0..1
// ---------------------------------------------------------------------------

export function sizeScore(face, preset = SIZE_PRESETS.fun) {
  const [tooSmall, idealLo, idealHi, tooBig] = preset;
  if (face <= tooSmall * 0.5) return 0;
  if (face < idealLo) return ((face - tooSmall * 0.5) / (idealLo - tooSmall * 0.5)) ** 1.3;
  if (face <= idealHi) return 1;
  if (face <= tooBig) return 1 - 0.6 * ((face - idealHi) / (tooBig - idealHi));
  return Math.max(0.1, 0.4 - 0.1 * (face - tooBig));
}

/** Longer period = more organised, more powerful lines. */
export function periodScore(t) {
  if (!(t > 0)) return 0;
  return Math.min(1, Math.max(0.15, (t - 5) / 9)); // 6 s -> 0.15ish, 14 s+ -> 1
}

/**
 * Wind: offshore (blowing from land to sea) grooms waves; onshore wrecks them.
 * Light wind is good from any direction.
 */
export function windScore(speedKn, fromDir, facing) {
  if (speedKn == null || fromDir == null) return { score: 0.8, kind: "unknown" };
  const offshoreFrom = (facing + 180) % 360;
  const rel = angleDiff(fromDir, offshoreFrom); // 0 = dead offshore, 180 = dead onshore
  const onshoreness = (1 - Math.cos((rel * Math.PI) / 180)) / 2; // 0..1
  const kind = speedKn < 5 ? "light" : rel < 60 ? "offshore" : rel > 120 ? "onshore" : "cross-shore";
  const strength = Math.min(1, Math.max(0, (speedKn - 5) / 15)); // 5 kn -> 0, 20 kn -> 1
  let score = 1 - 0.9 * onshoreness * strength;
  // Gale-force wind from any direction: unsurfable and dangerous to be out in
  if (speedKn > 20) score *= Math.max(0.1, 1 - (speedKn - 20) / 22); // 25 kn x0.77, 35 kn x0.32
  if (kind === "cross-shore" && speedKn > 15) score *= 0.9;
  return { score: Math.max(0.05, score), kind, rel };
}

// ---------------------------------------------------------------------------
// Put it together
// ---------------------------------------------------------------------------

/**
 * Score one spot at one hour.
 * `fc` = { swells: [{h,t,dir}, ...], windWave: {h,t,dir}, windKn, windDir, gustKn }
 * Returns { score 0..10, face (m), factors, notes[] }.
 */
export function scoreSpot(spot, bits, fc, preset = SIZE_PRESETS.fun, binDeg = 5) {
  const comps = (fc.swells || []).map((s) => ({ ...s, ...swellAtSpot(spot, bits, s, binDeg) }));
  const ww = fc.windWave ? swellAtSpot(spot, bits, fc.windWave, binDeg) : { height: 0 };

  const swellFace = Math.sqrt(comps.reduce((a, c) => a + c.height ** 2, 0));
  const face = Math.sqrt(swellFace ** 2 + 0.5 * ww.height ** 2);
  const main = comps.reduce((best, c) => (c.height > (best?.height ?? 0) ? c : best), null);

  const size = sizeScore(face, preset);
  const period = main ? periodScore(main.t) : 0;
  const wind = windScore(fc.windKn, fc.windDir, spot.facing);
  const clean = swellFace + ww.height > 0 ? swellFace ** 2 / (swellFace ** 2 + ww.height ** 2) : 0;
  const geo = 0.6 + 0.4 * (spot.potential ?? 0.5);

  const raw = size * (0.35 + 0.65 * period) * wind.score * (0.55 + 0.45 * clean) * geo;
  const score = Math.round(Math.min(10, raw * 10.5) * 10) / 10;

  return {
    score,
    face,
    main,
    factors: { size, period, wind: wind.score, windKind: wind.kind, clean, geo },
  };
}

/** Plain-language reasons behind a score, for the spot detail panel. */
export function explain(spot, bits, fc, result, fmtHeight, binDeg = 5) {
  const notes = [];
  const m = result.main;
  if (!m || m.height === 0) {
    notes.push({ ok: false, text: "No swell reaching this spot right now (blocked or flat)." });
  } else {
    const inWin = m.exposure > 0.6;
    notes.push({
      ok: inWin,
      text: `Main swell ${fmtHeight(m.h)} @ ${Math.round(m.t)} s from ${compass(m.dir)} (${Math.round(m.dir)}°) — ` +
        (inWin ? "inside this spot's swell window" : m.exposure > 0.2 ? "on the edge of the swell window" : "mostly blocked here"),
    });
    if (m.angle > 50) notes.push({ ok: false, text: `Swell hits ${Math.round(m.angle)}° off the beach's facing, so it loses size wrapping in.` });
    if (m.t >= 13) notes.push({ ok: true, text: "Long-period groundswell: more power, bigger sets than the offshore height suggests." });
    else if (m.t < 9) notes.push({ ok: false, text: "Short-period swell: likely weaker, less organised waves." });
  }
  const wk = result.factors.windKind;
  const windTxt = fc.windKn != null ? `${Math.round(fc.windKn)} kn from ${compass(fc.windDir)}` : "unknown";
  notes.push({
    ok: wk === "offshore" || wk === "light",
    text: `Wind ${windTxt}: ${wk === "light" ? "light — glassy-ish" : wk}` + (wk === "onshore" && fc.windKn > 12 ? " — choppy" : ""),
  });
  if (result.factors.clean < 0.6) notes.push({ ok: false, text: "Lots of local wind chop mixed into the swell." });
  if (spot.type === "point") notes.push({ ok: true, text: "Headland/point geometry: swell can wrap and peel along it." });
  if (spot.ridge > 0.3) notes.push({ ok: true, text: "Offshore ridge or shoal may focus swell here (refraction)." });
  if (spot.ridge < -0.3) notes.push({ ok: null, text: "Offshore trough/canyon: swell may spread out here, or focus at its edges." });
  if ((spot.shelf ?? 1) < 0.8) notes.push({ ok: false, text: "Swell crosses shallow bars or estuary to get here, losing much of its size on the way." });
  if (spot.profile && spot.profile[0] > 20) notes.push({ ok: false, text: "Deep water right at the shore — waves may just slam rock." });
  return notes;
}

/** A best guess at tide preference from the seafloor shape. Shown as a hint, not used in the score. */
export function tideHint(spot) {
  const [d250, , d1k] = spot.profile || [];
  if (spot.type === "flat-shelf" || d1k < 6) return "Shallow shelf: likely best from mid to high tide (may close out or dry at low).";
  if (d250 > 12) return "Deep close to shore: may need lower tide before waves start breaking.";
  if (spot.type === "point" || spot.type === "islet") return "Rocky point/reef likely: check it first on a mid tide, rising.";
  return "No strong tide signal from the depth data — try mid tide first.";
}
