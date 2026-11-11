// Curation mode (open the page with ?curate=1). Regular testers never load this file.
//
// Steve can remove a zone, or draw around a bigger area, with an optional private note.
// Removals are saved on this device, shown on the map, and can be emailed (with notes)
// or downloaded as the pipeline's curated.json (shapes only). The pipeline then drops
// those areas for everyone on the next rebuild.

import { toGeometry, newRemoval, pipelineFile, mailtoUrl, areaKm2 } from "./curation.js";
import { decodeRing } from "./zones.js";
import { FEEDBACK_EMAIL } from "./config.js";

const KEY = "snowCuration.v1";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function initCuration({ map, getRegion, onChange }) {
  let list = load();
  let drawing = null;           // { pts: [[lat, lon]], line, dots }
  const shapes = L.layerGroup().addTo(map);

  // --- toolbar -------------------------------------------------------------
  const bar = document.createElement("div");
  bar.id = "curateBar";
  bar.innerHTML = `<b>Curation mode</b>
    <button type="button" id="cDraw">Draw an area to remove</button>
    <span id="cDrawing" hidden>Tap the map to outline the area.
      <button type="button" id="cUndo">Undo point</button>
      <button type="button" id="cFinish" disabled>Finish</button>
      <button type="button" id="cCancel">Cancel</button></span>
    <button type="button" id="cList">Removals (<span id="cCount">0</span>)</button>`;
  document.querySelector("main").appendChild(bar);

  // --- dialogs -------------------------------------------------------------
  const noteDlg = document.createElement("dialog");
  noteDlg.id = "curateNote";
  noteDlg.innerHTML = `<h2>Remove this area?</h2>
    <p id="cWhat" class="small"></p>
    <label for="cNote">Private note (optional). Only you see it; it never goes into the app or the public files.</label>
    <textarea id="cNote" rows="3" placeholder="e.g. sacred site, locals' request"></textarea>
    <div class="row"><button type="button" id="cSave">Remove for everyone on the next rebuild</button>
    <button type="button" class="plain" id="cNoteCancel">Cancel</button></div>`;
  document.body.appendChild(noteDlg);

  const listDlg = document.createElement("dialog");
  listDlg.id = "curateList";
  document.body.appendChild(listDlg);

  // --- drawing removed areas -----------------------------------------------
  function redraw() {
    shapes.clearLayers();
    for (const r of list) {
      const ll = r.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]);
      L.polygon(ll, { color: "#b00020", weight: 2, dashArray: "4 4", fillColor: "#555", fillOpacity: 0.55, interactive: true })
        .bindTooltip(`Removed${r.note ? `: ${esc(r.note)}` : ""} (gone for everyone after the next rebuild)`)
        .addTo(shapes);
    }
    document.getElementById("cCount").textContent = list.length;
    onChange?.();
  }

  function ask(what, geometry, source) {
    document.getElementById("cWhat").textContent = `${what} · about ${areaKm2(geometry).toFixed(2)} km²`;
    document.getElementById("cNote").value = "";
    noteDlg.showModal();
    return new Promise((resolve) => {
      const done = (ok) => {
        noteDlg.close();
        document.getElementById("cSave").onclick = document.getElementById("cNoteCancel").onclick = null;
        if (!ok) return resolve(false);
        list.push(newRemoval({ geometry, note: document.getElementById("cNote").value, region: getRegion(), source }));
        if (!save(list)) alert("Couldn't save on this device (private browsing?). Email or download the list before closing the page.");
        redraw();
        resolve(true);
      };
      document.getElementById("cSave").onclick = () => done(true);
      document.getElementById("cNoteCancel").onclick = () => done(false);
    });
  }

  // --- drawing a new area --------------------------------------------------
  function setDrawing(on) {
    document.getElementById("cDraw").hidden = on;
    document.getElementById("cDrawing").hidden = !on;
    map.getContainer().style.cursor = on ? "crosshair" : "";
    if (drawing) { drawing.line.remove(); drawing.dots.remove(); }
    drawing = on ? { pts: [], line: L.polygon([], { color: "#b00020", weight: 2 }).addTo(map), dots: L.layerGroup().addTo(map) } : null;
  }
  function refreshDrawing() {
    drawing.line.setLatLngs(drawing.pts);
    drawing.dots.clearLayers();
    for (const p of drawing.pts) L.circleMarker(p, { radius: 4, color: "#b00020", fillOpacity: 1 }).addTo(drawing.dots);
    document.getElementById("cFinish").disabled = drawing.pts.length < 3;
  }
  map.on("click", (e) => {
    if (!drawing) return;
    drawing.pts.push([e.latlng.lat, e.latlng.lng]);
    refreshDrawing();
  });
  document.getElementById("cDraw").onclick = () => setDrawing(true);
  document.getElementById("cCancel").onclick = () => setDrawing(false);
  document.getElementById("cUndo").onclick = () => { drawing.pts.pop(); refreshDrawing(); };
  document.getElementById("cFinish").onclick = async () => {
    const geometry = toGeometry(drawing.pts, 0);
    setDrawing(false);
    if (geometry) await ask("A drawn area", geometry, "drawn");
  };

  // --- the list ------------------------------------------------------------
  function download(name, obj) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function showList() {
    const mail = list.length ? mailtoUrl(FEEDBACK_EMAIL, list) : null;
    listDlg.innerHTML = `<h2>Your removals (${list.length})</h2>
      ${list.length ? "" : "<p>Nothing removed yet. Open a zone and tap “Remove this area”, or draw around a bigger area.</p>"}
      <ol class="removals">${list.map((r) => `<li>
        <b>${esc(r.source)}</b> <span class="small">${esc(r.added.slice(0, 10))} · ${esc(r.region)} · ${areaKm2(r.geometry).toFixed(2)} km²</span>
        ${r.note ? `<br><i>${esc(r.note)}</i>` : ""}
        <br><button type="button" class="plain" data-zoom="${esc(r.id)}">Show on map</button>
        <button type="button" class="plain" data-del="${esc(r.id)}">Undo removal</button></li>`).join("")}</ol>
      ${list.length ? `<p class="small">Send the list to yourself to keep the notes, and download the pipeline file for the rebuild.
        Removals stay on this device until you undo them.</p>
      <div class="row">
        ${mail ? `<a class="btn" href="${esc(mail)}">Email list (with notes)</a>`
          : `<span class="small">Too long to email in one go: download your private list instead.</span>`}
        <button type="button" id="cDlPipe">Download for the pipeline (shapes only)</button>
        <button type="button" class="plain" id="cDlPriv">Download private list (with notes)</button>
      </div>` : ""}
      <div class="row"><button type="button" class="plain" id="cClose">Close</button></div>`;
    listDlg.querySelectorAll("[data-zoom]").forEach((b) => b.onclick = () => {
      const r = list.find((x) => x.id === b.dataset.zoom);
      listDlg.close();
      map.fitBounds(r.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]), { maxZoom: 14 });
    });
    listDlg.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
      list = list.filter((x) => x.id !== b.dataset.del);
      save(list);
      redraw();
      showList();
    });
    const pipe = listDlg.querySelector("#cDlPipe");
    if (pipe) pipe.onclick = async () => {
      let current = null;
      try {
        const res = await fetch("pipeline/exclusions/curated.json", { cache: "no-store" });
        if (res.ok) current = await res.json();
      } catch { /* offline: start from an empty file */ }
      if (!current) alert("Couldn't read the current curated.json, so this file holds only this device's removals. Merge by hand, or ask Claude to.");
      download("curated.json", pipelineFile(current, list));
    };
    const priv = listDlg.querySelector("#cDlPriv");
    if (priv) priv.onclick = () => download(`snow-removals-private-${new Date().toISOString().slice(0, 10)}.json`, list);
    listDlg.querySelector("#cClose").onclick = () => listDlg.close();
    if (!listDlg.open) listDlg.showModal();
  }
  document.getElementById("cList").onclick = showList;

  redraw();

  return {
    isDrawing: () => !!drawing,
    /** Adds the "Remove this area" button to a zone's detail panel. */
    afterDetail(z, panel) {
      const already = list.some((r) => r.source.startsWith(`zone ${z.id} `) || r.source === `zone ${z.id}`);
      const box = document.createElement("div");
      box.className = "curate-box";
      box.innerHTML = already ? '<p class="small">You have removed this zone. It disappears for everyone after the next rebuild.</p>'
        : '<button type="button">Remove this area</button><p class="small">Curation mode: removes this zone for everyone on the next rebuild.</p>';
      const btn = box.querySelector("button");
      if (btn) btn.onclick = async () => {
        const geometry = toGeometry(decodeRing(z.c, z.p));
        if (geometry && await ask(`Zone ${z.id}${z.n ? ` near ${z.n}` : ""}`, geometry, `zone ${z.id}${z.n ? ` (near ${z.n})` : ""}`)) {
          box.innerHTML = '<p class="small">Removed. It disappears for everyone after the next rebuild.</p>';
        }
      };
      panel.prepend(box);
    },
  };
}
