// The spot detail panel: score now, best upcoming windows, 7-day chart,
// swell-window compass, seafloor profile, tide curve and the "why" list.
// Charts are plain SVG strings, no chart library.

import { scoreSpot, explain, windowRanges, compass, tideHint } from "./scoring.js";
import { fetchTides, tideAt, tideState } from "./tides.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderDetail(el, spot, ctx) {
  const h = ctx.hour;
  const c = ctx.conds[h];
  const result = c ? scoreSpot(spot, spot.bits, c, ctx.sizePreset, ctx.binDeg) : null;
  const notes = result ? explain(spot, spot.bits, c, result, ctx.fmtHeight, ctx.binDeg) : [];
  const score = ctx.scores[h];
  const gmaps = `https://www.google.com/maps/@${spot.lat},${spot.lon},2500m/data=!3m1!1e3`;

  el.innerHTML = `
    <div class="d-head">
      <span class="badge" style="--c:${ctx.scoreColor(score)}">${score.toFixed(1)}</span>
      <div>
        <h2 class="d-title">${esc(ctx.name)}</h2>
        <div class="d-meta">${spot.known ? "Known break" : "Unexplored candidate"} · ${esc(ctx.typeLabel)} · ${esc(spot.region)}</div>
        <div class="d-meta">${esc(ctx.where)}</div>
      </div>
    </div>
    <div class="d-links">
      <span>${spot.lat.toFixed(4)}, ${spot.lon.toFixed(4)}</span>
      <a href="${gmaps}" target="_blank" rel="noopener">Satellite in Google Maps ↗</a>
    </div>

    <div class="card">
      <h3>${esc(ctx.fmtTime(ctx.times[h]))}${ctx.daylight[h] ? "" : " · dark"}</h3>
      <div class="now-stats">
        <div><b>${ctx.fmtFace(ctx.faces[h])}</b><span>wave face</span></div>
        <div><b>${result?.main ? Math.round(result.main.t) + " s" : "–"}</b><span>period</span></div>
        <div><b>${c?.windKn != null ? Math.round(c.windKn) + " kn" : "–"}</b><span>${c?.windKn != null ? compass(c.windDir) + " · " + result.factors.windKind : "wind"}</span></div>
      </div>
    </div>

    <div class="card">
      <h3>Next 7 days</h3>
      ${weekChart(ctx)}
      <p class="hint">Bars = wave face height, coloured by score. Shaded = dark. Tap to jump to that hour.</p>
    </div>

    <div class="card">
      <h3>Best upcoming windows</h3>
      <ul class="windows">${bestWindows(ctx).map((w) => `
        <li><button data-hour="${w.hour}"><span>${esc(ctx.fmtTime(ctx.times[w.hour]))}</span>
        <span>${ctx.fmtFace(ctx.faces[w.hour])} · <b style="color:${ctx.scoreColor(w.score)}">${w.score.toFixed(1)}</b></span></button></li>`).join("") || "<li class='hint'>Nothing above 3/10 in daylight this week.</li>"}
      </ul>
    </div>

    <div class="card">
      <h3>Why this score</h3>
      <ul class="reasons">${notes.map((n) => `<li class="${n.ok === true ? "ok" : n.ok === false ? "no" : ""}">${esc(n.text)}</li>`).join("")}</ul>
    </div>

    <div class="two-col">
      <div class="card">
        <h3>Swell window</h3>
        ${windowRose(spot, c)}
        <p class="hint">Open to ${esc(windowRanges(spot.bits, ctx.binDeg).join(", "))}</p>
      </div>
      <div class="card">
        <h3>Seafloor out front</h3>
        ${profileChart(spot, ctx)}
        <p class="hint">Depth along the direction the coast faces (${spot.facing}°).</p>
      </div>
    </div>

    <div class="card">
      <h3>Tide · ${esc(ctx.station.name)} <span class="hint">(${spot.tideKm} km away)</span></h3>
      <div id="tide-box"><p class="hint">Loading tides…</p></div>
      <p class="hint">${esc(tideHint(spot))} <em>(A guess from depth data, not used in the score.)</em></p>
    </div>`;

  el.querySelectorAll("[data-hour]").forEach((b) =>
    b.addEventListener("click", () => ctx.onPickHour(+b.dataset.hour)));
  const chart = el.querySelector(".week-chart");
  if (chart) {
    chart.addEventListener("click", (e) => {
      const r = chart.getBoundingClientRect();
      const frac = (e.clientX - r.left) / r.width;
      ctx.onPickHour(Math.round(frac * (ctx.times.length - 1)));
    });
  }
  loadTide(el.querySelector("#tide-box"), ctx);
}

// ---------------------------------------------------------------------------

function bestWindows(ctx) {
  // best daylight hour per day, then the top three days
  const byDay = new Map();
  for (let h = 0; h < ctx.times.length; h++) {
    if (!ctx.daylight[h] || ctx.times[h] * 1000 < Date.now() - 36e5) continue;
    const day = ctx.fmtDay(ctx.times[h]);
    const cur = byDay.get(day);
    if (!cur || ctx.scores[h] > cur.score) byDay.set(day, { hour: h, score: ctx.scores[h] });
  }
  return [...byDay.values()].filter((w) => w.score >= 3).sort((a, b) => b.score - a.score).slice(0, 3)
    .sort((a, b) => a.hour - b.hour);
}

function weekChart(ctx) {
  const W = 360, H = 120, pad = 18;
  const n = ctx.times.length;
  const maxFace = Math.max(2, ...ctx.faces);
  const x = (i) => pad + (i / (n - 1)) * (W - pad - 4);
  const y = (m) => H - pad - (m / maxFace) * (H - pad - 8);
  const bw = (W - pad) / n + 0.3;
  let s = `<svg class="chart week-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Seven day wave height and score chart">`;
  for (let i = 0; i < n; i++) {
    if (!ctx.daylight[i]) s += `<rect x="${x(i)}" y="4" width="${bw}" height="${H - pad - 4}" fill="#000" opacity="0.35"/>`;
  }
  for (let i = 0; i < n; i++) {
    const f = ctx.faces[i];
    if (f > 0) s += `<rect x="${x(i)}" y="${y(f)}" width="${bw}" height="${H - pad - y(f)}" fill="${ctx.scoreColor(ctx.scores[i])}"/>`;
  }
  // day labels at local midnight
  let lastDay = "";
  for (let i = 0; i < n; i++) {
    const d = ctx.fmtDay(ctx.times[i]).split(",")[0];
    if (d !== lastDay) {
      if (lastDay) s += `<line x1="${x(i)}" x2="${x(i)}" y1="4" y2="${H - pad}" stroke="#ffffff" stroke-opacity="0.15"/>`;
      // skip the label for a partial first day if the next one would overlap it
      const roomy = lastDay || ctx.fmtDay(ctx.times[Math.min(i + 10, n - 1)]).split(",")[0] === d;
      if (roomy) s += `<text x="${x(i) + 3}" y="${H - 5}">${d}</text>`;
      lastDay = d;
    }
  }
  const unitTop = ctx.fmtFace(maxFace).split("–").pop();
  s += `<text x="2" y="12">${unitTop}</text>`;
  s += `<line x1="${x(ctx.hour)}" x2="${x(ctx.hour)}" y1="2" y2="${H - pad}" stroke="#fff" stroke-width="1.5"/>`;
  return s + "</svg>";
}

function windowRose(spot, c) {
  const S = 150, R = 58, cx = S / 2, cy = S / 2;
  const pt = (deg, r) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
  let s = `<svg class="chart" viewBox="0 0 ${S} ${S}" role="img" aria-label="Swell window compass">`;
  s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#0d1418" stroke="#24343e"/>`;
  // open sectors
  spot.bits.forEach((b, i) => {
    if (!b) return;
    const a0 = i * 5 - 2.5, a1 = i * 5 + 2.5;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
    s += `<path d="M${cx},${cy} L${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1} Z" fill="#4fd1c5" fill-opacity="0.35"/>`;
  });
  for (const [lbl, d] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const [tx, ty] = pt(d, R + 9);
    s += `<text x="${tx}" y="${ty + 3}" text-anchor="middle">${lbl}</text>`;
  }
  // facing arrow (land -> sea)
  const [fx, fy] = pt(spot.facing, R - 6);
  s += `<line x1="${cx}" y1="${cy}" x2="${fx}" y2="${fy}" stroke="#e6eef2" stroke-width="2" stroke-dasharray="3 2"/>`;
  // swell arrows travel from their direction towards the spot (centre)
  if (c) {
    c.swells.forEach((sw, k) => {
      const [sx, sy] = pt(sw.dir, R + 2);
      const [ex, ey] = pt(sw.dir, 12);
      s += arrow(sx, sy, ex, ey, k === 0 ? "#3f8fb8" : "#7fb7d6", k === 0 ? 3 : 2);
    });
    if (c.windKn != null) {
      const [wx, wy] = pt(c.windDir, R * 0.85);
      const [wx2, wy2] = pt(c.windDir, R * 0.3);
      s += arrow(wx, wy, wx2, wy2, "#f2c66d", 1.5);
    }
  }
  s += `<circle cx="${cx}" cy="${cy}" r="3" fill="#fff"/>`;
  s += `</svg><p class="hint"><span style="color:#4fd1c5">■</span> open to swell · <span style="color:#3f8fb8">→</span> swell · <span style="color:#f2c66d">→</span> wind · ┄ faces</p>`;
  return s;
}

function arrow(x1, y1, x2, y2, color, w) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx = x2 - 7 * Math.cos(a - 0.45), hy = y2 - 7 * Math.sin(a - 0.45);
  const kx = x2 - 7 * Math.cos(a + 0.45), ky = y2 - 7 * Math.sin(a + 0.45);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}"/>` +
    `<path d="M${x2},${y2} L${hx},${hy} L${kx},${ky} Z" fill="${color}"/>`;
}

function profileChart(spot) {
  const W = 150, H = 110, padL = 26, padB = 16;
  const dist = [0, 0.25, 0.5, 1, 2, 3, 5, 8];
  const depth = [0, ...spot.profile.map((d) => Math.max(d, 0))];
  const maxD = Math.max(20, ...depth);
  const x = (km) => padL + (km / 8) * (W - padL - 6);
  const y = (d) => 6 + (d / maxD) * (H - padB - 6);
  const pts = dist.map((km, i) => `${x(km)},${y(depth[i])}`).join(" ");
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Seafloor depth profile">`;
  s += `<rect x="${padL}" y="6" width="${W - padL - 6}" height="${H - padB - 6}" fill="#123448"/>`;
  s += `<polygon points="${padL},${H - padB} ${pts} ${x(8)},${H - padB}" fill="#c2a878" opacity="0.85"/>`;
  s += `<polyline points="${pts}" fill="none" stroke="#e8d6ae" stroke-width="1.5"/>`;
  s += `<text x="2" y="12">0 m</text><text x="2" y="${H - padB}">${Math.round(maxD)} m</text>`;
  s += `<text x="${padL}" y="${H - 3}">shore</text><text x="${W - 6}" y="${H - 3}" text-anchor="end">8 km</text>`;
  return s + "</svg>";
}

async function loadTide(box, ctx) {
  if (!box) return;
  try {
    const t0 = ctx.times[0] * 1000;
    const t1 = ctx.times[ctx.times.length - 1] * 1000;
    const events = await fetchTides(ctx.station, t0, t1);
    if (!box.isConnected) return;
    const at = ctx.times[ctx.hour] * 1000;
    const level = tideAt(events, at);
    const st = tideState(events, at);
    box.innerHTML = tideChart(events, at, ctx) +
      `<p class="hint">${level != null ? `${level.toFixed(1)} m and ${st?.rising ? "rising" : "falling"}` : ""}` +
      `${st ? ` · next ${st.next.type === "H" ? "high" : "low"} ${ctx.fmtTime(st.next.t / 1000)} (${st.next.v.toFixed(1)} m)` : ""}</p>`;
  } catch (err) {
    box.innerHTML = `<p class="hint">Couldn't load tides for this station (${esc(err.message)}).</p>`;
  }
}

function tideChart(events, at, ctx) {
  // 24 hours centred on the selected time
  const W = 360, H = 80, pad = 14;
  const from = at - 12 * 36e5, to = at + 12 * 36e5;
  const vals = [];
  for (let t = from; t <= to; t += 15 * 6e4) vals.push([t, tideAt(events, t)]);
  const good = vals.filter((v) => v[1] != null);
  if (!good.length) return "<p class='hint'>No tide data for this time.</p>";
  const lo = Math.min(...good.map((v) => v[1])), hi = Math.max(...good.map((v) => v[1]));
  const x = (t) => pad + ((t - from) / (to - from)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const path = good.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tide curve">`;
  s += `<path d="${path} L${x(good[good.length - 1][0])},${H - pad} L${x(good[0][0])},${H - pad} Z" fill="#3f8fb8" opacity="0.3"/>`;
  s += `<path d="${path}" fill="none" stroke="#7fb7d6" stroke-width="1.5"/>`;
  for (const e of events) {
    if (e.t < from || e.t > to) continue;
    s += `<text x="${x(e.t)}" y="${e.type === "H" ? y(e.v) - 4 : y(e.v) + 11}" text-anchor="middle" class="lbl">${e.type} ${e.v.toFixed(1)}</text>`;
  }
  s += `<line x1="${x(at)}" x2="${x(at)}" y1="2" y2="${H - pad}" stroke="#fff" stroke-width="1.5"/>`;
  s += `<text x="${pad}" y="${H - 2}">−12 h</text><text x="${W - pad}" y="${H - 2}" text-anchor="end">+12 h</text>`;
  return s + "</svg>";
}

