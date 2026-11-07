// Surf reports: what a person actually saw at a spot, stored next to what the app
// predicted for the same place and time. Comparing the two is how we find out
// whether the model rings true.
//
// Pure functions only (no page, no storage, no network) so they can be tested: npm test

// Answer choices. `value` is what gets stored; keep values stable so old reports
// stay comparable even if the wording changes.
export const CHOICES = {
  seen: [
    { value: "surfed", label: "Surfed it" },
    { value: "watched", label: "Watched from shore" },
    { value: "camera", label: "Camera or photo" },
  ],
  wave: [
    { value: "rideable", label: "Yes — rideable waves" },
    { value: "unrideable", label: "Breaks, but not rideable (closeouts, rocks, shorebreak)" },
    { value: "none", label: "No real wave here" },
    { value: "unknown", label: "Couldn't tell / didn't get there" },
  ],
  // face height, with a midpoint in feet for comparing against the app
  size: [
    { value: "flat", label: "Flat", ft: 0 },
    { value: "ankle-knee", label: "Ankle to knee (1–2 ft)", ft: 1.5 },
    { value: "knee-waist", label: "Knee to waist (2–3 ft)", ft: 2.5 },
    { value: "waist-chest", label: "Waist to chest (3–4 ft)", ft: 3.5 },
    { value: "head", label: "Head high (5–6 ft)", ft: 5.5 },
    { value: "overhead", label: "Overhead (6–8 ft)", ft: 7 },
    { value: "double", label: "Double overhead+ (10 ft+)", ft: 11 },
  ],
  quality: [
    { value: 1, label: "1 · Poor / unsurfable" },
    { value: 2, label: "2 · Fair" },
    { value: 3, label: "3 · Fun" },
    { value: 4, label: "4 · Good" },
    { value: 5, label: "5 · Epic" },
  ],
  surface: [
    { value: "glassy", label: "Glassy" },
    { value: "texture", label: "Light texture" },
    { value: "choppy", label: "Choppy" },
    { value: "blown", label: "Blown out" },
  ],
  bottom: [
    { value: "sand", label: "Sand" },
    { value: "reef", label: "Rock reef / ledge" },
    { value: "cobble", label: "Cobble or boulders" },
    { value: "river", label: "River mouth" },
    { value: "unsure", label: "Not sure" },
  ],
  crowd: [
    { value: "nobody", label: "Nobody" },
    { value: "few", label: "A few people" },
    { value: "crowded", label: "Crowded" },
  ],
};

export function labelFor(field, value) {
  const c = (CHOICES[field] || []).find((x) => String(x.value) === String(value));
  return c ? c.label : "";
}

const r1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const M_TO_FT = 3.281;

/**
 * Build a report object.
 * `input`      = the person's answers (from the form)
 * `spot`       = the spot record (id, lat, lon, known, region, type)
 * `prediction` = what the app predicted at that time, or null if outside the loaded forecast
 */
export function buildReport(input, spot, prediction, { modelVersion, now = Date.now() } = {}) {
  const size = CHOICES.size.find((s) => s.value === input.size);
  return {
    id: `r${now.toString(36)}`,
    createdAt: new Date(now).toISOString(),
    modelVersion: modelVersion || null,
    spot: {
      id: spot.id,
      name: spot.known || null,
      lat: spot.lat,
      lon: spot.lon,
      region: spot.region,
      type: spot.type,
    },
    observed: {
      time: new Date(input.time).toISOString(),
      seen: input.seen || null,
      wave: input.wave || null,
      size: input.size || null,
      sizeFt: size ? size.ft : null,
      quality: input.quality ? Number(input.quality) : null,
      surface: input.surface || null,
      bottom: input.bottom || null,
      crowd: input.crowd || null,
      notes: (input.notes || "").trim(),
      reporter: (input.reporter || "").trim(),
    },
    predicted: prediction ? {
      time: new Date(prediction.time).toISOString(),
      score: r1(prediction.score),
      faceFt: r1(prediction.faceM * M_TO_FT),
      swellFt: r1(prediction.swellM * M_TO_FT),
      swellPeriod: r1(prediction.swellT),
      swellDir: prediction.swellDir != null ? Math.round(prediction.swellDir) : null,
      windKn: r1(prediction.windKn),
      windDir: prediction.windDir != null ? Math.round(prediction.windDir) : null,
      windKind: prediction.windKind || null,
      tideM: r1(prediction.tideM),
      sizePreset: prediction.sizePreset || null,
    } : null,
  };
}

/**
 * Quick verdict comparing the person's rating with the app's score, both on 0-10.
 * Quality 1-5 maps to 0, 2.5, 5, 7.5, 10.
 */
export function compare(report) {
  const p = report.predicted;
  const o = report.observed;
  if (!p || !o.quality) return null;
  const theirs = (o.quality - 1) * 2.5;
  const diff = p.score - theirs;
  const verdict = Math.abs(diff) <= 2 ? "match" : diff > 0 ? "app too high" : "app too low";
  return { theirs, ours: p.score, diff: Math.round(diff * 10) / 10, verdict };
}

/** Local time with its zone name, e.g. "Sat, Nov 7, 9:00 AM PST". Uses the reporter's own clock by default. */
function localTime(iso, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
}

export function reportSubject(report) {
  const where = report.spot.name || report.spot.id;
  const day = report.observed.time.slice(0, 10);
  return `Surf report: ${where} (${day})`;
}

/** Readable email text, plus one machine-readable line at the end for analysis. */
export function reportBody(report, { timeZone } = {}) {
  const o = report.observed;
  const p = report.predicted;
  const lines = [
    `Spot: ${report.spot.name || "Unexplored " + report.spot.id} — ${report.spot.region}`,
    `Location: ${report.spot.lat}, ${report.spot.lon}`,
    `When: ${localTime(o.time, timeZone)} (${o.time.replace("T", " ").slice(0, 16)} UTC)`,
    "",
    "WHAT I SAW",
    `Seen: ${labelFor("seen", o.seen) || "–"}`,
    `A wave here? ${labelFor("wave", o.wave) || "–"}`,
    `Size: ${labelFor("size", o.size) || "–"}`,
    `Quality: ${labelFor("quality", o.quality) || "–"}`,
    `Surface: ${labelFor("surface", o.surface) || "–"}`,
    `Bottom: ${labelFor("bottom", o.bottom) || "–"}`,
    `Crowd: ${labelFor("crowd", o.crowd) || "–"}`,
  ];
  if (o.notes) lines.push(`Notes: ${o.notes}`);
  if (o.reporter) lines.push(`From: ${o.reporter}`);
  lines.push("", "WHAT THE APP PREDICTED");
  if (p) {
    lines.push(
      `Score: ${p.score}/10 (${p.sizePreset} size setting)`,
      `Wave face: ~${p.faceFt} ft · Swell ${p.swellFt ?? "–"} ft @ ${p.swellPeriod ?? "–"} s from ${p.swellDir ?? "–"}°`,
      `Wind: ${p.windKn ?? "–"} kn from ${p.windDir ?? "–"}° (${p.windKind ?? "–"})` + (p.tideM != null ? ` · Tide ${p.tideM} m` : ""),
    );
  } else {
    lines.push("(Not captured — the time was outside the loaded forecast. Can be looked up later.)");
  }
  lines.push("", `DATA ${JSON.stringify(report)}`);
  return lines.join("\n");
}

/** A mailto: link for one or more reports. Returns null if it would be too long for email apps. */
export function mailtoUrl(email, reports, maxLength = 7500) {
  const list = Array.isArray(reports) ? reports : [reports];
  const subject = list.length === 1 ? reportSubject(list[0]) : `Surf reports (${list.length})`;
  const body = list.map((r) => reportBody(r)).join("\n\n----------\n\n");
  const url = `mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return url.length <= maxLength ? url : null;
}

const CSV_COLUMNS = [
  ["report_id", (r) => r.id],
  ["created_at", (r) => r.createdAt],
  ["model_version", (r) => r.modelVersion],
  ["spot_id", (r) => r.spot.id],
  ["spot_name", (r) => r.spot.name],
  ["lat", (r) => r.spot.lat],
  ["lon", (r) => r.spot.lon],
  ["region", (r) => r.spot.region],
  ["spot_type", (r) => r.spot.type],
  ["observed_time_utc", (r) => r.observed.time],
  ["seen", (r) => r.observed.seen],
  ["wave_here", (r) => r.observed.wave],
  ["size", (r) => r.observed.size],
  ["size_ft", (r) => r.observed.sizeFt],
  ["quality_1_5", (r) => r.observed.quality],
  ["surface", (r) => r.observed.surface],
  ["bottom", (r) => r.observed.bottom],
  ["crowd", (r) => r.observed.crowd],
  ["notes", (r) => r.observed.notes],
  ["reporter", (r) => r.observed.reporter],
  ["app_score", (r) => r.predicted?.score],
  ["app_face_ft", (r) => r.predicted?.faceFt],
  ["app_swell_ft", (r) => r.predicted?.swellFt],
  ["app_swell_period_s", (r) => r.predicted?.swellPeriod],
  ["app_swell_dir", (r) => r.predicted?.swellDir],
  ["app_wind_kn", (r) => r.predicted?.windKn],
  ["app_wind_dir", (r) => r.predicted?.windDir],
  ["app_wind_kind", (r) => r.predicted?.windKind],
  ["app_tide_m", (r) => r.predicted?.tideM],
  ["app_size_setting", (r) => r.predicted?.sizePreset],
];

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** All reports as a CSV spreadsheet (opens in Excel, Numbers or Google Sheets). */
export function reportsToCSV(reports) {
  const head = CSV_COLUMNS.map(([name]) => name).join(",");
  const rows = reports.map((r) => CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  return [head, ...rows].join("\r\n") + "\r\n";
}
