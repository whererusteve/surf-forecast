// App entry point: loads spots, fetches forecasts, scores everything, draws the map and list.

import { unpackWindow, scoreSpot, SIZE_PRESETS, compass } from "./scoring.js";
import { fetchForecasts, conditionsAt } from "./forecast.js";
import { isDaylight } from "./sun.js";
import { renderDetail } from "./detail.js";
import { openReportForm, renderReportsPanel } from "./feedback.js";

const $ = (id) => document.getElementById(id);
// Times show on the viewer's own clock. (BC and Washington no longer always share a
// clock: BC now stays on daylight time year-round, Washington still falls back.)
const TZ = undefined;
const LIST_SIZE = 40;
const DEDUPE_KM = 3;

export const TYPE_LABELS = {
  point: "Point / headland",
  islet: "Islet / outer reef",
  cove: "Cove / bay",
  "flat-shelf": "Shallow shelf",
  coast: "Open coast",
};

const state = {
  data: null,
  spots: [],
  fc: null,          // forecast data from Open-Meteo
  nHours: 0,
  scores: null,      // Float32Array [spot * nHours + hour]
  faces: null,       // Float32Array, breaking face height (m)
  daylight: null,    // Uint8Array [forecastPoint * nHours + hour]
  hour: 0,
  mode: "time",      // "time" | "week"
  show: "all",
  size: "fun",
  region: "",
  units: "ft",
  selected: null,
};

// ---------------------------------------------------------------------------
// Formatting helpers (shared with detail.js through `ctx`)
// ---------------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", day: "numeric", hour: "numeric" });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });

/** "Thu 12, 2 PM" — weekday plus date, since the forecast spans 8 calendar days. */
export function fmtTime(unix) {
  const p = Object.fromEntries(timeFmt.formatToParts(new Date(unix * 1000)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day}, ${p.hour} ${p.dayPeriod}`;
}
export function fmtDay(unix) { return dayFmt.format(new Date(unix * 1000)); }

function fmtFace(m) {
  if (!(m > 0.05)) return "flat";
  if (state.units === "m") {
    const lo = m * 0.8, hi = m * 1.1;
    const r = (x) => (x < 3 ? x.toFixed(1) : Math.round(x));
    return `${r(lo)}–${r(hi)} m`;
  }
  const ft = m * 3.281;
  if (ft < 1) return "<1 ft";
  const lo = Math.max(1, Math.round(ft * 0.8)), hi = Math.round(ft * 1.1);
  return lo >= hi ? `${lo} ft` : `${lo}–${hi} ft`;
}

function fmtHeight(m) {
  if (m == null) return "–";
  return state.units === "m" ? `${m.toFixed(1)} m` : `${(m * 3.281).toFixed(1)} ft`;
}

export function scoreColor(s) {
  if (s >= 8) return "#ff6b4a";
  if (s >= 6) return "#f2c94c";
  if (s >= 4) return "#3fc0a8";
  if (s >= 2) return "#3f8fb8";
  return "#3b5566";
}

function spotName(s) { return s.known || `Unexplored ${s.id}`; }

function spotWhere(s) {
  const dist = s.tideKm < 1 ? "at" : `${Math.round(s.tideKm)} km ${compass(s.nearBearing)} of`;
  return `${dist} ${s.near}`;
}

function kmBetween(a, b) {
  const dy = (a.lat - b.lat) * 111.2;
  const dx = (a.lon - b.lon) * 111.2 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([50.0, -127.5], 6);
const esri = "https://server.arcgisonline.com/ArcGIS/rest/services";
const satellite = L.tileLayer(`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
}).addTo(map);
const ocean = L.tileLayer(`${esri}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 13, attribution: "Ocean basemap © Esri, GEBCO, NOAA",
});
const labels = L.tileLayer(`${esri}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 19, attribution: "Labels © Esri",
}).addTo(map);
L.control.layers(
  { "Satellite": satellite, "Seafloor depth": ocean },
  { "Place names": labels },
  { position: "topright" },
).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const renderer = L.canvas({ padding: 0.3 });
const markerLayer = L.layerGroup().addTo(map);
let selectedRing = null;

function buildMarkers() {
  for (const s of state.spots) {
    s.marker = L.circleMarker([s.lat, s.lon], {
      renderer, radius: 4, weight: s.known ? 1.5 : 0, color: "#ffffff",
      fillColor: "#3b5566", fillOpacity: 0.5,
    });
    s.marker.bindTooltip(() => tooltipFor(s), { direction: "top", offset: [0, -4] });
    s.marker.on("click", () => selectSpot(s));
  }
}

function tooltipFor(s) {
  const v = currentValue(s);
  const when = state.mode === "week" && v.hour != null ? ` · best ${fmtTime(state.fc.times[v.hour])}` : "";
  return `<b>${spotName(s)}</b><br>${v.score.toFixed(1)}/10 · ${fmtFace(v.face)}${when}`;
}

// ---------------------------------------------------------------------------
// Scoring for all spots and hours
// ---------------------------------------------------------------------------

async function computeScores() {
  const { spots, fc } = state;
  const nH = state.nHours;
  const preset = SIZE_PRESETS[state.size];
  const binDeg = state.data.binDeg;
  state.scores = new Float32Array(spots.length * nH);
  state.faces = new Float32Array(spots.length * nH);

  // conditions are shared by every spot on the same forecast point, so build them once
  const conds = fc.points.map((p) => Array.from({ length: nH }, (_, h) => conditionsAt(p, h)));

  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const row = conds[s.fp];
    for (let h = 0; h < nH; h++) {
      const c = row[h];
      if (!c) { state.scores[i * nH + h] = 0; continue; }
      const r = scoreSpot(s, s.bits, c, preset, binDeg);
      state.scores[i * nH + h] = r.score;
      state.faces[i * nH + h] = r.face;
    }
    if (i % 800 === 799) {
      setStatus(`Scoring spots… ${Math.round((100 * i) / spots.length)}%`);
      await new Promise((r) => setTimeout(r, 0)); // let the page breathe
    }
  }
  state.conds = conds;
}

function computeDaylight() {
  const { fc, data } = state;
  const nH = state.nHours;
  state.daylight = new Uint8Array(data.forecastPoints.length * nH);
  data.forecastPoints.forEach(([la, lo], p) => {
    for (let h = 0; h < nH; h++) state.daylight[p * nH + h] = isDaylight(la, lo, fc.times[h] * 1000) ? 1 : 0;
  });
}

/** Score to show for a spot: at the chosen hour, or its best daylight hour this week. */
function currentValue(s) {
  const nH = state.nHours;
  const base = s.index * nH;
  if (state.mode === "time") {
    return { score: state.scores[base + state.hour], face: state.faces[base + state.hour], hour: state.hour };
  }
  let best = -1, bh = null;
  for (let h = state.hour; h < nH; h++) {
    if (!state.daylight[s.fp * nH + h]) continue;
    const v = state.scores[base + h];
    if (v > best) { best = v; bh = h; }
  }
  return bh == null ? { score: 0, face: 0, hour: null } : { score: best, face: state.faces[base + bh], hour: bh };
}

// ---------------------------------------------------------------------------
// Rendering: map colours + ranked list
// ---------------------------------------------------------------------------

function visible(s) {
  if (state.show === "unexplored" && s.known) return false;
  if (state.show === "known" && !s.known) return false;
  if (state.region && s.region !== state.region) return false;
  return true;
}

function render() {
  if (!state.scores) return;
  const rows = [];
  markerLayer.clearLayers();
  for (const s of state.spots) {
    if (!visible(s)) continue;
    const v = currentValue(s);
    s.view = v;
    s.marker.setStyle({
      fillColor: scoreColor(v.score),
      radius: 3 + v.score * 0.55,
      fillOpacity: v.score >= 4 ? 0.95 : 0.45,
    });
    markerLayer.addLayer(s.marker);
    rows.push(s);
  }
  rows.sort((a, b) => b.view.score - a.view.score);

  // keep the list varied: skip spots within a few km of a better one already listed
  const picked = [];
  for (const s of rows) {
    if (picked.length >= LIST_SIZE || s.view.score <= 0) break;
    if (picked.some((p) => kmBetween(p, s) < DEDUPE_KM)) continue;
    picked.push(s);
  }

  $("list-title").textContent = state.mode === "week"
    ? "Best spots this week (daylight)"
    : `Top spots · ${fmtTime(state.fc.times[state.hour])}`;
  const list = $("spot-list");
  list.innerHTML = "";
  if (!picked.length) list.innerHTML = `<li class="empty">Nothing scoring right now with these filters.</li>`;
  for (const s of picked) {
    const v = s.view;
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `
      <span class="badge" style="--c:${scoreColor(v.score)}">${v.score.toFixed(1)}</span>
      <div style="min-width:0">
        <div class="spot-name">${s.known ? `<span class="tag known">known</span>` : `<span class="tag">new</span>`}${spotName(s)}</div>
        <div class="spot-sub">${s.region} · ${TYPE_LABELS[s.type]} · ${spotWhere(s)}</div>
      </div>
      <div class="spot-size">${fmtFace(v.face)}<small>${state.mode === "week" && v.hour != null ? fmtTime(state.fc.times[v.hour]) : windWord(s)}</small></div>`;
    li.addEventListener("click", () => selectSpot(s));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") selectSpot(s); });
    list.appendChild(li);
  }

  if (state.selected) {
    if (state.selected.marker) state.selected.marker.bringToFront();
    showDetail(state.selected);
  }
}

function windWord(s) {
  const c = state.conds[s.fp][state.hour];
  if (!c || c.windKn == null) return "";
  return `${Math.round(c.windKn)} kn ${compass(c.windDir)}`;
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function selectSpot(s, { pan = true } = {}) {
  if (state.selected !== s) $("report").innerHTML = "";
  state.selected = s;
  history.replaceState(null, "", `#${s.id}`);
  if (selectedRing) selectedRing.remove();
  selectedRing = L.circleMarker([s.lat, s.lon], {
    renderer, radius: 14, weight: 2, color: "#ffffff", fill: false, interactive: false,
  }).addTo(map);
  if (pan) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 12));
  showDetail(s);
}

function showDetail(s) {
  $("list-view").hidden = true;
  $("detail-view").hidden = false;
  const nH = state.nHours;
  renderDetail($("detail"), s, {
    name: spotName(s),
    where: spotWhere(s),
    typeLabel: TYPE_LABELS[s.type],
    binDeg: state.data.binDeg,
    hour: state.mode === "week" && s.view?.hour != null ? s.view.hour : state.hour,
    times: state.fc.times,
    conds: state.conds[s.fp],
    scores: state.scores.subarray(s.index * nH, (s.index + 1) * nH),
    faces: state.faces.subarray(s.index * nH, (s.index + 1) * nH),
    daylight: state.daylight.subarray(s.fp * nH, (s.fp + 1) * nH),
    station: state.data.tideStations[s.tide],
    sizePreset: SIZE_PRESETS[state.size],
    fmtFace, fmtHeight, fmtTime, fmtDay, scoreColor,
    onPickHour: (h) => { setMode("time"); setHour(h); },
    onReport: () => openReportForm($("report"), s, () => reportCtx(s), { onSaved: refreshReports }),
  });
}

/** Forecast arrays for one spot, used to record what the app predicted in a surf report. */
function reportCtx(s) {
  const nH = state.nHours;
  return {
    name: spotName(s),
    times: state.fc.times,
    conds: state.conds[s.fp],
    scores: state.scores.subarray(s.index * nH, (s.index + 1) * nH),
    faces: state.faces.subarray(s.index * nH, (s.index + 1) * nH),
    station: state.data.tideStations[s.tide],
    sizePreset: SIZE_PRESETS[state.size],
    sizeName: state.size,
    binDeg: state.data.binDeg,
  };
}

function refreshReports() {
  renderReportsPanel($("my-reports-body"), $("my-reports-count"), {
    onOpenSpot: (lat, lon) => {
      // spot IDs can change when the data is rebuilt, so find the spot by location
      let best = null;
      let bestKm = 1;
      for (const s of state.spots) {
        const km = kmBetween(s, { lat, lon });
        if (km < bestKm) { best = s; bestKm = km; }
      }
      if (best) selectSpot(best);
    },
  });
}

function closeDetail() {
  state.selected = null;
  history.replaceState(null, "", location.pathname + location.search);
  if (selectedRing) { selectedRing.remove(); selectedRing = null; }
  $("report").innerHTML = "";
  $("detail-view").hidden = true;
  $("list-view").hidden = false;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function setHour(h) {
  state.hour = Math.max(0, Math.min(state.nHours - 1, h));
  $("t-slider").value = state.hour;
  $("t-label").textContent = state.mode === "week"
    ? `From ${fmtTime(state.fc.times[state.hour])} onwards`
    : fmtTime(state.fc.times[state.hour]);
  render();
}

function setMode(mode) {
  state.mode = mode;
  $("mode-time").classList.toggle("on", mode === "time");
  $("mode-week").classList.toggle("on", mode === "week");
  $("mode-time").setAttribute("aria-selected", mode === "time");
  $("mode-week").setAttribute("aria-selected", mode === "week");
  if (mode === "week") setHour(nowHour()); else setHour(state.hour);
}

function nowHour() {
  const now = Date.now() / 1000;
  const i = state.fc.times.findIndex((t) => t > now - 1800);
  return i < 0 ? 0 : i;
}

function wireControls() {
  $("t-slider").addEventListener("input", (e) => setHour(+e.target.value));
  $("t-prev").addEventListener("click", () => setHour(state.hour - 1));
  $("t-next").addEventListener("click", () => setHour(state.hour + 1));
  $("t-now").addEventListener("click", () => setHour(nowHour()));
  $("mode-time").addEventListener("click", () => setMode("time"));
  $("mode-week").addEventListener("click", () => setMode("week"));
  $("f-show").addEventListener("change", (e) => { state.show = e.target.value; render(); });
  $("f-region").addEventListener("change", (e) => {
    state.region = e.target.value;
    render();
    const pts = state.spots.filter(visible).map((s) => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(pts, { padding: [20, 20], maxZoom: 11 });
  });
  $("f-units").addEventListener("change", (e) => { state.units = e.target.value; render(); });
  $("f-size").addEventListener("change", async (e) => {
    state.size = e.target.value;
    await computeScores();
    setStatus(statusLine());
    render();
  });
  $("back").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight") setHour(state.hour + 1);
    if (e.key === "ArrowLeft") setHour(state.hour - 1);
    if (e.key === "Escape") closeDetail();
  });
}

function statusLine() {
  const n = state.spots.length;
  const known = state.spots.filter((s) => s.known).length;
  const at = new Date(state.fc.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${n.toLocaleString()} candidate spots (${known} near known breaks) · forecast loaded ${at}`;
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

async function init() {
  wireControls();
  refreshReports();
  try {
    const data = await (await fetch("data/spots.json")).json();
    state.data = data;
    state.spots = data.spots.map((s, i) => ({ ...s, index: i, bits: unpackWindow(s.window) }));
    const regions = [...new Set(state.spots.map((s) => s.region))].sort();
    for (const r of regions) $("f-region").insertAdjacentHTML("beforeend", `<option>${r}</option>`);
    buildMarkers();

    setStatus(`Fetching swell & wind for ${data.forecastPoints.length} offshore points…`);
    state.fc = await fetchForecasts(data.forecastPoints, (p) =>
      setStatus(`Fetching swell & wind… ${Math.round(p * 100)}%`));
    state.nHours = state.fc.times.length;
    $("t-slider").max = state.nHours - 1;
    computeDaylight();
    await computeScores();
    setStatus(statusLine());

    state.hour = nowHour();
    setHour(state.hour);

    const fromHash = location.hash.slice(1);
    const linked = fromHash && state.spots.find((s) => s.id === fromHash);
    if (linked) selectSpot(linked);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't load the forecast (${err.message}). Try again in a minute.`, true);
  }
}

init();
