// The surf report form and the "Your surf reports" list.
// Reports are saved in this browser (localStorage) and sent by email when the
// person chooses to. Nothing is published anywhere.

import { scoreSpot } from "./scoring.js";
import { fetchTides, tideAt } from "./tides.js";
import { CHOICES, labelFor, buildReport, compare, mailtoUrl, reportsToCSV } from "./reports.js";
import { FEEDBACK_EMAIL, MODEL_VERSION } from "./config.js";

const STORE_KEY = "surfReports.v1";
const NAME_KEY = "surfReports.reporter";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// Saving on this device. Browser storage can be switched off (private windows,
// strict settings), so every read and write is guarded.
// ---------------------------------------------------------------------------

export function loadReports() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { return []; }
}

function saveReports(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

function rememberedName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}

function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* fine */ }
}

// ---------------------------------------------------------------------------
// What the app predicted for this spot at a given time
// ---------------------------------------------------------------------------

async function predictionAt(spot, ctx, tMs) {
  let best = -1;
  let gap = Infinity;
  ctx.times.forEach((t, i) => {
    const d = Math.abs(t * 1000 - tMs);
    if (d < gap) { gap = d; best = i; }
  });
  if (best < 0 || gap > 90 * 60 * 1000) return null; // outside the loaded forecast
  const c = ctx.conds[best];
  if (!c) return null;
  const r = scoreSpot(spot, spot.bits, c, ctx.sizePreset, ctx.binDeg);
  let tideM = null;
  try {
    const events = await fetchTides(ctx.station, ctx.times[0] * 1000, ctx.times[ctx.times.length - 1] * 1000);
    tideM = tideAt(events, tMs);
  } catch { /* tide is a nice-to-have */ }
  return {
    time: ctx.times[best] * 1000,
    score: ctx.scores[best],
    faceM: ctx.faces[best],
    swellM: r.main?.h ?? null,
    swellT: r.main?.t ?? null,
    swellDir: r.main?.dir ?? null,
    windKn: c.windKn,
    windDir: c.windDir,
    windKind: r.factors.windKind,
    tideM,
    sizePreset: ctx.sizeName,
  };
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function options(field, placeholder = "Choose…") {
  return `<option value="">${placeholder}</option>` +
    CHOICES[field].map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join("");
}

function localInputValue(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM" in the person's own time zone
}

/**
 * Show the report form for `spot` inside `el`.
 * `getCtx()` returns the current forecast arrays for the spot (fresh each call,
 * in case the size setting changed while the form was open).
 */
export function openReportForm(el, spot, getCtx, { onSaved } = {}) {
  const ctx = getCtx();
  el.innerHTML = `
    <form class="card report-form" novalidate>
      <h3>Report what you saw · ${esc(ctx.name)}</h3>
      <p class="hint">Saved on this device. Sending it opens an email you can read before it goes. Nothing is published.</p>
      <label>When <input name="time" type="datetime-local" required value="${localInputValue(Date.now())}"></label>
      <label>How did you see it? <select name="seen">${options("seen")}</select></label>
      <label>Is there a wave here? <select name="wave" required>${options("wave")}</select></label>
      <div class="form-row">
        <label>Size <select name="size">${options("size")}</select></label>
        <label>Quality <select name="quality">${options("quality")}</select></label>
      </div>
      <div class="form-row">
        <label>Surface <select name="surface">${options("surface")}</select></label>
        <label>Bottom <select name="bottom">${options("bottom")}</select></label>
      </div>
      <label>Crowd <select name="crowd">${options("crowd")}</select></label>
      <label>Notes <textarea name="notes" rows="3" placeholder="Which way it broke, best tide, access, hazards…"></textarea></label>
      <label>Your name (optional) <input name="reporter" type="text" autocomplete="name" value="${esc(rememberedName())}"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="form-actions">
        <button type="submit" class="btn">Save report</button>
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
      </div>
    </form>`;

  const form = el.querySelector("form");
  form.querySelector("[data-cancel]").addEventListener("click", () => { el.innerHTML = ""; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const errorBox = form.querySelector(".form-error");
    const when = Date.parse(data.time);
    if (!data.time || Number.isNaN(when)) return showError(errorBox, "Please set when you were there.");
    if (when > Date.now() + 3600e3) return showError(errorBox, "That time is in the future — reports are for what you've already seen.");
    if (!data.wave) return showError(errorBox, "Please answer “Is there a wave here?” — even “No real wave here” is useful.");

    form.querySelector("button[type=submit]").disabled = true;
    if (data.reporter) rememberName(data.reporter.trim());
    const prediction = await predictionAt(spot, getCtx(), when);
    const report = buildReport({ ...data, time: when }, spot, prediction, { modelVersion: MODEL_VERSION });
    const list = loadReports();
    list.unshift(report);
    const saved = saveReports(list);
    showSaved(el, report, saved);
    onSaved?.();
  });
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showError(box, msg) {
  box.textContent = msg;
  box.hidden = false;
}

function verdictText(report) {
  const cmp = compare(report);
  if (!cmp) return report.predicted ? "" : "The app's prediction for that time wasn't loaded, so it'll be looked up later.";
  const word = { match: "close to what you saw", "app too high": "higher than what you saw", "app too low": "lower than what you saw" }[cmp.verdict];
  return `You rated it ${labelFor("quality", report.observed.quality)}. The app said ${cmp.ours}/10 — ${word}.`;
}

function showSaved(el, report, saved) {
  const url = mailtoUrl(FEEDBACK_EMAIL, report);
  el.innerHTML = `
    <div class="card report-form">
      <h3>${saved ? "Report saved on this device" : "Couldn't save on this device"}</h3>
      <p>${esc(verdictText(report))}</p>
      ${saved ? "" : "<p class='form-error'>This browser blocks saving. Send it now so it isn't lost.</p>"}
      <div class="form-actions">
        <a class="btn" href="${esc(url)}" data-mail="${esc(report.id)}">Email this report</a>
        <button type="button" class="btn ghost" data-done>Done</button>
      </div>
      ${FEEDBACK_EMAIL ? "" : "<p class='hint'>Add the address to send it to in the email's “To” line.</p>"}
    </div>`;
  el.querySelector("[data-done]").addEventListener("click", () => { el.innerHTML = ""; });
  el.querySelector("[data-mail]").addEventListener("click", () => markEmailed([report.id]));
}

function markEmailed(ids) {
  const list = loadReports();
  const stamp = new Date().toISOString();
  for (const r of list) if (ids.includes(r.id)) r.emailedAt = stamp;
  saveReports(list);
}

// ---------------------------------------------------------------------------
// "Your surf reports" list at the bottom of the panel
// ---------------------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });

export function renderReportsPanel(el, countEl, { onOpenSpot } = {}) {
  const list = loadReports();
  countEl.textContent = list.length ? `(${list.length})` : "";
  if (!list.length) {
    el.innerHTML = `<p>No reports yet. Open any spot and use <strong>Report what you saw</strong> at the bottom after you've checked it or surfed it — including when the app got it wrong. Those are the most useful reports.</p>`;
    return;
  }
  const allUrl = mailtoUrl(FEEDBACK_EMAIL, list);
  el.innerHTML = `
    <ul class="report-list">${list.map((r) => {
      const cmp = compare(r);
      return `<li>
        <button class="linkish" data-open="${esc(r.id)}">${esc(r.spot.name || "Unexplored " + r.spot.id)}</button>
        <span class="hint">${esc(dateFmt.format(new Date(r.observed.time)))} · ${esc(labelFor("wave", r.observed.wave).split(" (")[0])}${cmp ? ` · you ${r.observed.quality}/5, app ${cmp.ours}/10` : ""}${r.emailedAt ? " · emailed" : ""}</span>
        <span class="report-actions">
          <a href="${esc(mailtoUrl(FEEDBACK_EMAIL, r) || "#")}" data-mail="${esc(r.id)}">Email</a>
          <button class="linkish danger" data-delete="${esc(r.id)}">Delete</button>
        </span>
      </li>`;
    }).join("")}</ul>
    <div class="form-actions">
      ${allUrl ? `<a class="btn" href="${esc(allUrl)}" data-mail-all>Email all</a>` : ""}
      <button type="button" class="btn ghost" data-download>Download spreadsheet</button>
    </div>
    ${allUrl ? "" : "<p class='hint'>Too many reports for one email — download the spreadsheet and attach it instead.</p>"}
    <p class="hint">Reports live in this browser only. Clearing your browser data deletes them, so send them along.</p>`;

  const refresh = () => renderReportsPanel(el, countEl, { onOpenSpot });
  el.querySelectorAll("[data-mail]").forEach((a) => a.addEventListener("click", () => { markEmailed([a.dataset.mail]); setTimeout(refresh, 0); }));
  el.querySelector("[data-mail-all]")?.addEventListener("click", () => { markEmailed(list.map((r) => r.id)); setTimeout(refresh, 0); });
  el.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => {
    if (!confirm("Delete this report from this device?")) return;
    saveReports(loadReports().filter((r) => r.id !== b.dataset.delete));
    refresh();
  }));
  el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    const r = list.find((x) => x.id === b.dataset.open);
    if (r) onOpenSpot?.(r.spot.lat, r.spot.lon);
  }));
  el.querySelector("[data-download]").addEventListener("click", () => {
    const blob = new Blob([reportsToCSV(list)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `surf-reports-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
