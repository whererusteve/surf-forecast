import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyRing, toGeometry, areaKm2, newRemoval, pipelineFile, removalsBody, mailtoUrl } from "../../snow/js/curation.js";

const square = [[50.0, -123.0], [50.0, -122.99], [50.01, -122.99], [50.01, -123.0]];   // [lat, lon]

test("an outline becomes a closed GeoJSON polygon in [lon, lat]", () => {
  const g = toGeometry(square, 0);
  assert.equal(g.type, "Polygon");
  assert.deepEqual(g.coordinates[0][0], [-123, 50]);
  assert.deepEqual(g.coordinates[0].at(-1), g.coordinates[0][0]);
  assert.equal(g.coordinates[0].length, 5);
  assert.equal(toGeometry(square.slice(0, 2)), null);
});

test("simplifying drops points on a straight edge but keeps the corners", () => {
  const ring = [[-123, 50], [-122.995, 50.00001], [-122.99, 50], [-122.99, 50.01], [-123, 50.01]];
  const out = simplifyRing(ring, 0.0003);
  assert.ok(!out.some((p) => p[0] === -122.995));
  assert.ok(out.length >= 4);
});

test("area of a ~0.72 x 1.1 km box", () => {
  const a = areaKm2(toGeometry(square, 0));
  assert.ok(a > 0.75 && a < 0.85, `got ${a}`);
});

test("the pipeline file gets shapes only, never the private note", () => {
  const r = newRemoval({ geometry: toGeometry(square, 0), note: "sacred site", region: "sea-to-sky",
    source: "zone S-0001 (near Metal Dome)", now: new Date("2026-11-11T18:00:00Z"), id: "R-1" });
  const file = pipelineFile({ _about: "x", version: 1, shapes: [] }, [r]);
  assert.equal(file.shapes.length, 1);
  assert.deepEqual(Object.keys(file.shapes[0]).sort(), ["added", "geometry", "id", "region"]);
  assert.ok(!JSON.stringify(file).includes("sacred"));
  assert.ok(!JSON.stringify(file).includes("Metal Dome"));
  assert.equal(file._about, "x");
});

test("removals already in the pipeline file aren't added twice", () => {
  const r = newRemoval({ geometry: toGeometry(square, 0), region: "sea-to-sky", source: "drawn", id: "R-1" });
  const once = pipelineFile(null, [r]);
  const twice = pipelineFile(once, [r]);
  assert.equal(twice.shapes.length, 1);
});

test("the email keeps the notes (it goes to Steve's own inbox) and ends with a DATA line", () => {
  const r = newRemoval({ geometry: toGeometry(square, 0), note: "locals' stash", region: "sea-to-sky", source: "drawn", id: "R-1" });
  const body = removalsBody([r]);
  assert.match(body, /Note: locals' stash/);
  assert.match(body.split("\n").at(-1), /^DATA \[/);
  assert.ok(mailtoUrl("a@b.c", [r]).startsWith("mailto:a%40b.c?subject="));
  assert.equal(mailtoUrl("a@b.c", [r], 100), null);
});
