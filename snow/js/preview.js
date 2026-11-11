// Zone preview: shows the pipeline's zones on a map, with travel time, use level,
// slope mix, wind exposure and the areas to respect. No forecasts yet.

import {
  decodeRing, bestAccess, accessSummary, fmtHours, aspectName, windDirs, fixedHours, rescaleHours,
  USE_LABELS, BAND_LABELS, SLOPE_CLASSES, ATES_LABELS, atesSummary,
} from "./zones.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { data: null, layer: null, areaLayer: null, glacierLayer: null, glacierText: null, selected: null, byId: new Map() };
let curation = null;   // curation mode tools, loaded only with ?curate=1

// --- Map --------------------------------------------------------------------

const esri = "https://server.arcgisonline.com/ArcGIS/rest/services";
const topo = L.tileLayer(`${esri}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 17, attribution: "Topo © Esri and contributors",
});
const satellite = L.tileLayer(`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 18, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
});
const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([50.1, -122.9], 10);
topo.addTo(map);
L.control.layers({ Topo: topo, Satellite: satellite }, null, { position: "topleft" }).addTo(map);
map.attributionControl.addAttribution('Zones: Copernicus DEM, ESA WorldCover, BC Data Catalogue, <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a>');

// --- Colours ----------------------------------------------------------------

const USE_COL = ["#2c7bb6", "#fdae61", "#d7301f"];
const BAND_COL = ["#4d9221", "#e6ab02", "#5e6c84"];
// ATES map colours: simple green, challenging blue, complex black, extreme red
const ATES_COL = ["#4daf4a", "#377eb8", "#222222", "#d62728"];
const NOT_MODELLED = "#bdbdbd";
function timeCol(h) {
  return h == null ? "#999" : h <= 2 ? "#1a9850" : h <= 3.5 ? "#a6d96a" : h <= 5 ? "#fee08b" : h <= 8 ? "#f46d43" : "#a50026";
}
function steepCol(pct) {
  return pct < 10 ? "#ffffcc" : pct < 25 ? "#fed976" : pct < 45 ? "#fd8d3c" : pct < 65 ? "#e31a1c" : "#800026";
}
const LEGENDS = {
  use: [[USE_COL[2], "Well-travelled"], [USE_COL[1], "Occasional"], [USE_COL[0], "Little sign of travel"]],
  time: [["#1a9850", "≤ 2 h"], ["#a6d96a", "2–3.5 h"], ["#fee08b", "3.5–5 h"], ["#f46d43", "5–8 h"], ["#a50026", "> 8 h"]],
  steep: [["#ffffcc", "< 10% over 35°"], ["#fed976", "10–25%"], ["#fd8d3c", "25–45%"], ["#e31a1c", "45–65%"], ["#800026", "> 65%"]],
  band: [[BAND_COL[2], "Alpine"], [BAND_COL[1], "Treeline"], [BAND_COL[0], "Below treeline"]],
  ates: [[ATES_COL[3], "Mostly Extreme"], [ATES_COL[2], "Mostly Complex"], [ATES_COL[1], "Mostly Challenging"], [ATES_COL[0], "Mostly Simple"], [NOT_MODELLED, "Not modelled yet"]],
};

// --- Settings from the controls ---------------------------------------------

function settings() {
  return {
    colour: $("colour").value,
    maxH: Number($("maxH").value),
    rate: Number($("pace").value),
    modes: [...document.querySelectorAll(".mode:checked")].map((x) => x.value),
    uses: new Set([...document.querySelectorAll(".use:checked")].map((x) => Number(x.value))),
    showAreas: $("showAreas").checked,
    showGlaciers: $("showGlaciers").checked,
  };
}

// --- Drawing ----------------------------------------------------------------

function draw() {
  const d = state.data;
  if (!d) return;
  const s = settings();
  if (state.layer) state.layer.remove();
  drawGlaciers(s.showGlaciers);   // first, so zones are drawn on top of them
  state.layer = L.layerGroup();
  let shown = 0;
  for (const z of d.zones) {
    if (!s.uses.has(z.use)) continue;
    const best = bestAccess(z, { modes: s.modes, maxH: s.maxH, rate: s.rate, gates: d.gates });
    if (!best) continue;
    const steep = (z.mix[2] || 0) + (z.mix[3] || 0);
    const col = s.colour === "use" ? USE_COL[z.use] : s.colour === "time" ? timeCol(best.h)
      : s.colour === "steep" ? steepCol(steep)
      : s.colour === "ates" ? (z.aa ? ATES_COL[atesSummary(z.aa).dominant] : NOT_MODELLED) : BAND_COL[z.b];
    const poly = L.polygon(decodeRing(z.c, z.p), {
      color: col, weight: 0.6, fillColor: col, fillOpacity: 0.5,
    });
    poly.on("click", () => { if (!curation?.isDrawing()) select(z); });
    state.layer.addLayer(poly);
    shown++;
  }
  state.layer.addTo(map);
  drawAreas(s.showAreas);
  $("count").textContent = `${shown.toLocaleString()} of ${d.zones.length.toLocaleString()} zones shown.`;
  $("legend").innerHTML = `<b>${esc($("colour").selectedOptions[0].text.replace("Colour: ", ""))}</b>` +
    LEGENDS[s.colour].map(([c, t]) => `<div><span class="sw" style="background:${c}"></span>${esc(t)}</div>`).join("") +
    (s.showGlaciers ? '<div><span class="sw glacier"></span>Glacier (not a zone)</div>' : "") +
    (s.showAreas ? `<div><span class="sw line heli"></span>Heli-ski tenure</div>
      <div><span class="sw line cult"></span>Cultural area (flagged)</div>
      <div><span class="sw line prop"></span>Proposed resort</div>
      <div><span class="sw closed"></span>Closed: cultural site</div>` : "");
}

const AREA_STYLE = {
  heli: { color: "#6a3d9a", weight: 2, dashArray: "6 5", fill: false },
  cultural: { color: "#1b7837", weight: 2, dashArray: "2 5", fill: false },
  proposedResort: { color: "#b35806", weight: 2, dashArray: "8 4", fill: false },
  closed: { color: "#222", weight: 1, fillColor: "#222", fillOpacity: 0.45 },
};

const GLACIER_STYLE = { color: "#3f86b8", weight: 1, fillColor: "#bfe3f7", fillOpacity: 0.45 };

function drawGlaciers(show) {
  if (state.glacierLayer) state.glacierLayer.remove();
  state.glacierLayer = null;
  if (!show || !state.data.glaciers) return;
  state.glacierLayer = L.layerGroup();
  for (const g of state.data.glaciers) {
    for (const ring of g.rings) {
      const p = L.polygon(ring.map(([x, y]) => [y, x]), GLACIER_STYLE);
      p.on("click", () => { if (!curation?.isDrawing()) selectGlacier(g); });
      state.glacierLayer.addLayer(p);
    }
  }
  state.glacierLayer.addTo(map);
}

function selectGlacier(g) {
  state.selected = null;
  const t = state.glacierText || {};
  const names = g.n ? g.n.join(", ") : "";
  $("detailBody").innerHTML = `
    <h2>${esc(t.title || "Glacier")}${names ? `: ${esc(names)}` : ""}</h2>
    <p class="small">About ${g.km2} km² · ${g.el[0].toLocaleString()}–${g.el[1].toLocaleString()} m ·
      about ${Math.round(g.gentle * 100)}% gentler than ${state.data.settings.minSlope || 15}°</p>
    <p>${esc(t.paragraph || "")}</p>
    ${t.bullets ? `<ul>${t.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    <p class="small">${esc(t.sourceNote || "")}</p>
    <p class="small">Steeper slopes on and around the glacier are zones of their own: tap them for terrain, access and avalanche details.</p>`;
  $("detail").hidden = false;
}

function drawAreas(show) {
  if (state.areaLayer) state.areaLayer.remove();
  if (!show) return;
  const d = state.data;
  state.areaLayer = L.layerGroup();
  const add = (a, style) => {
    for (const ring of a.rings || []) {
      const p = L.polygon(ring.map(([x, y]) => [y, x]), { ...style, interactive: style === AREA_STYLE.closed });
      if (style === AREA_STYLE.closed) p.bindPopup(areaHtml(a, true));
      state.areaLayer.addLayer(p);
    }
  };
  for (const a of d.areas || []) add(a, AREA_STYLE[a.kind] || AREA_STYLE.cultural);
  for (const a of d.closedAreas || []) add(a, AREA_STYLE.closed);
  state.areaLayer.addTo(map);
}

// --- Detail panel -----------------------------------------------------------

function areaHtml(a, closed = false) {
  const nations = (a.nations || []).map((n) => (n.contact
    ? `<a href="${esc(n.contact)}" target="_blank" rel="noopener">${esc(n.name)}</a>` : esc(n.name))
    + (n.contactNote ? ` (${esc(n.contactNote)})` : "")).join(", ");
  const src = (a.sources || []).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join(" · ");
  return `<div class="area ${esc(a.kind)} ${closed ? "closed" : ""}">
    <b>${closed ? "Closed: " : ""}${esc(a.title)}</b>${a.status === "seasonal" ? ' <span class="pill">seasonal</span>' : ""}
    <p>${esc(a.why)}</p>
    ${nations ? `<p><b>Who to contact:</b> ${nations}</p>` : ""}
    ${src ? `<p class="small">Source: ${src}</p>` : ""}
    ${a.review ? '<p class="small review">Wording not yet reviewed by Steve.</p>' : ""}
  </div>`;
}

function select(z) {
  state.selected = z;
  const d = state.data;
  const s = settings();
  const best = bestAccess(z, { modes: ["skin", "sled", "lift"], rate: s.rate, gates: d.gates });
  const wl = windDirs(z.wl);
  const ws = windDirs(z.ws);
  const dirs = (o) => [o.strong.length ? `<b>${o.strong.join(", ")}</b>` : "", o.some.join(", ")].filter(Boolean).join(", ") || "none to speak of";
  const access = Object.entries(z.acc).map(([mode, a]) => {
    const fixed = fixedHours(mode, a, d.gates);
    const scaled = { ...a, h: rescaleHours(a.h, fixed, s.rate) };
    const gate = mode === "lift" ? d.gates[a.gate] : null;
    const th = a.th != null && d.trailheads ? d.trailheads[a.th] : null;
    return `<li>${esc(accessSummary(mode, scaled, fixed))}${gate ? ` <span class="small">via ${esc(gate.name)}</span>` : ""}
      ${th ? `<br><span class="small">From ${esc(th.name)}.</span> <span class="warn">${esc(th.note)}</span>` : ""}
      ${a.exp ? '<br><span class="warn">The approach crosses or runs under avalanche terrain (challenging or worse).</span>'
        : a.exp === null ? '<br><span class="small">Approach exposure not assessed yet: the avalanche terrain model hasn\'t run here.</span>' : ""}</li>`;
  }).join("");
  const flags = (z.fl || []).map((i) => areaHtml(d.areas[i])).join("");
  const permits = (z.prm || []).map((i) => d.permits[i]).filter(Boolean)
    .map((p) => `<div class="area permit"><b>${esc(p.name)}</b><p>${esc(p.text)}</p><a href="${esc(p.url)}" target="_blank" rel="noopener">Check current status</a></div>`).join("");
  const [u0, u1, u2] = z.u || [0, 0, 0];
  $("detailBody").innerHTML = `
    <h2>${esc(z.n ? `${aspectName(z.asp)}-facing slopes near ${z.n}` : `${aspectName(z.asp)}-facing ${BAND_LABELS[z.b].toLowerCase()} slopes`)}</h2>
    <p class="small">${esc(z.id)} · ${BAND_LABELS[z.b]} · ${z.el[0].toLocaleString()}–${z.el[2].toLocaleString()} m · ${z.km2} km² · faces ${aspectName(z.asp)} (${z.asp}°)</p>
    ${z.md ? '<p class="warn">Over 5 hours one way: overnight / multi-day objective.</p>' : ""}

    <h3>Slope angles</h3>
    <div class="mix">${z.mix.map((v, i) => `<div style="flex:${Math.max(v, 1)}" class="m${i}" title="${SLOPE_CLASSES[i]}: ${v}%">${v >= 8 ? v + "%" : ""}</div>`).join("")}</div>
    <p class="small">${z.mix.map((v, i) => `${SLOPE_CLASSES[i]}: ${v}%`).join(" · ")}. Official ATES rating: ${z.ates ? `in the ATES-mapped area “${esc(z.ates)}”. Its map comes first; see it for ratings` : "unrated"}.</p>
    <p class="small">Forest cover ${Math.round(z.tree * 100)}%${z.glac > 0.1 ? ` · glacier or permanent snow ${Math.round(z.glac * 100)}%` : ""}${z.trap > 0.1 ? ` · gullies / terrain traps ${Math.round(z.trap * 100)}%` : ""}.</p>

    <h3>Avalanche terrain <span class="small">(model estimate)</span></h3>
    ${atesHtml(z, d)}

    <h3>Getting there <span class="small">(estimates, not route advice)</span></h3>
    <ul class="access">${access}</ul>
    <p class="small">Munter method at ${s.rate} units/hour: 1 unit per km plus 1 per 100 m climbed. Sleds ${d.settings.sledKmh} km/h average, only on legal routes. ${best ? `Quickest: ${esc(best.mode)}, ~${fmtHours(best.h)}.` : ""}</p>

    <h3>Wind</h3>
    <p>Loaded by winds from: ${dirs(wl)}<br>Scoured by winds from: ${dirs(ws)}</p>
    <p class="small">From the shape of the terrain only. Local wind effects, cross-loading and cornices aren't modelled.</p>

    <h3>How travelled</h3>
    <p><b>${esc(USE_LABELS[z.use])}</b>: ${u0 ? `${(u0 / 1000).toFixed(1)} km of mapped ski routes, ` : ""}${u1} Mountain Information Network report${u1 === 1 ? "" : "s"} nearby, ${u2} public winter GPS track${u2 === 1 ? "" : "s"}.</p>
    ${z.use === 0 ? '<p class="small">Little-travelled terrain also has the least local information: fewer tracks to read and fewer observations, so more uncertainty.</p>' : ""}

    ${flags || permits ? `<h3>Know before you go</h3>${flags}${permits}` : ""}
  `;
  curation?.afterDetail(z, $("detailBody"));
  $("detail").hidden = false;
}

function atesHtml(z, d) {
  const m = d.atesModel || {};
  const sum = atesSummary(z.aa);
  if (!sum) return '<p class="small">Not modelled here yet. The avalanche terrain model is still being run across the region.</p>';
  return `<p><b>${esc(sum.text)}</b></p>
    <div class="mix ates">${z.aa.map((v, i) => `<div style="flex:${Math.max(v, 1)};background:${ATES_COL[i]}" title="${ATES_LABELS[i]}: ${v}%">${v >= 10 ? v + "%" : ""}</div>`).join("")}</div>
    <p class="small">${z.aa.map((v, i) => `${ATES_LABELS[i]}: ${v}%`).join(" · ")}.
    Estimated by <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name || "AutoATES")}</a> (${esc(m.cite || "")}).
    ${esc(m.note || "A model estimate, not an official ATES rating.")} It reads terrain only, not today's snowpack.</p>`;
}

// --- Loading ----------------------------------------------------------------

// One status message over the map, so a slow phone connection or an error is never silent
function status(msg, isError = false) {
  const el = $("status");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
}

const pending = new Map();   // region id -> fetch already under way

function fetchRegion(id) {
  if (!pending.has(id)) {
    pending.set(id, fetch(`data/zones-${id}.json`).then((res) => {
      if (!res.ok) throw new Error(`the zone file answered HTTP ${res.status}`);
      return res.json();
    }).catch((err) => { pending.delete(id); throw err; }));
  }
  return pending.get(id);
}

async function loadRegion(id) {
  status("Loading zones… (about 1 MB, can take a few seconds on mobile data)");
  try {
    state.data = await fetchRegion(id);
  } catch (err) {
    status(`Couldn't load the zones: ${err.message}. Check your connection and reload the page.`, true);
    return;
  }
  const b = state.data.bbox;
  map.fitBounds([[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]]);
  $("detail").hidden = true;
  draw();
  status("");
  try { localStorage.setItem("snowPreview.region", id); } catch { /* private mode */ }
  // ?zone=S-0123 opens one zone directly (handy for sharing a link)
  const wanted = new URLSearchParams(location.search).get("zone");
  const z = wanted && state.data.zones.find((x) => x.id === wanted);
  if (z) {
    map.setView(z.c, 13);
    select(z);
  }
}

async function init() {
  const idx = await (await fetch("data/regions.json")).json();
  let saved = null;
  try { saved = localStorage.getItem("snowPreview.region"); } catch { /* private mode */ }
  $("region").innerHTML = idx.regions.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  const asked = new URLSearchParams(location.search).get("region");
  const pick = asked || saved;
  const first = idx.regions.find((r) => r.id === pick) ? pick : "sea-to-sky";
  $("region").value = first;
  $("region").addEventListener("change", (e) => loadRegion(e.target.value));
  for (const el of document.querySelectorAll("#filters input, #filters select, #colour")) el.addEventListener("change", draw);
  $("filtersBtn").addEventListener("click", () => {
    const f = $("filters");
    f.hidden = !f.hidden;
    $("filtersBtn").setAttribute("aria-expanded", String(!f.hidden));
  });
  $("filtersDone").addEventListener("click", () => { $("filters").hidden = true; $("filtersBtn").setAttribute("aria-expanded", "false"); });
  $("closeDetail").addEventListener("click", () => { $("detail").hidden = true; });
  if (new URLSearchParams(location.search).get("curate") === "1") {
    const { initCuration } = await import("./curate-ui.js");
    curation = initCuration({ map, getRegion: () => $("region").value });
  }
  fetch("content/glaciers.json").then((r) => r.json()).then((t) => { state.glacierText = t; }).catch(() => {});
  fetchRegion(first).catch(() => {});   // start downloading while the disclaimer is read
  await showDisclaimer();
  await loadRegion(first);
}

async function showDisclaimer() {
  const d = await (await fetch("content/disclaimer.json")).json();
  const key = "snowDisclaimer.accepted";
  let ok = false;
  try { ok = Number(localStorage.getItem(key)) === d.version; } catch { /* private mode: show every time */ }
  if (ok) return;
  $("dTitle").textContent = d.title;
  $("dPara").textContent = d.paragraph;
  $("dList").innerHTML = d.bullets.map((b) => `<li>${esc(b)}</li>`).join("");
  $("dNote").textContent = d.bulletsNote || "";
  $("dAccept").textContent = d.accept;
  const dlg = $("disclaimer");
  dlg.showModal();
  dlg.addEventListener("cancel", (e) => e.preventDefault());   // Esc doesn't skip it
  await new Promise((resolve) => $("dAccept").addEventListener("click", () => {
    try { localStorage.setItem(key, String(d.version)); } catch { /* ignore */ }
    dlg.close();
    resolve();
  }, { once: true }));
}

init().catch((err) => {
  status(`Something went wrong loading the page: ${err.message}. Try reloading.`, true);
  console.error(err);
});
