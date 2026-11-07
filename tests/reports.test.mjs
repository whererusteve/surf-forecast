// Run with:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, compare, reportBody, mailtoUrl, reportsToCSV } from "../app/js/reports.js";

const spot = { id: "PNW-0123", known: null, lat: 49.2208, lon: -126.0333, region: "Clayoquot & Tofino", type: "point" };
const input = {
  time: "2026-11-07T17:00:00Z", seen: "surfed", wave: "rideable", size: "head", quality: "4",
  surface: "texture", bottom: "reef", crowd: "nobody", notes: 'Left off the point, "fun" on mid tide', reporter: "Steve",
};
const prediction = {
  time: Date.parse("2026-11-07T17:00:00Z"), score: 7.34, faceM: 1.6, swellM: 2.2, swellT: 13.4, swellDir: 265.4,
  windKn: 6.2, windDir: 90, windKind: "offshore", tideM: 2.14, sizePreset: "fun",
};
const now = Date.parse("2026-11-07T20:00:00Z");

test("a report keeps what was seen next to what was predicted", () => {
  const r = buildReport(input, spot, prediction, { modelVersion: "test", now });
  assert.equal(r.spot.lat, 49.2208);
  assert.equal(r.observed.sizeFt, 5.5);
  assert.equal(r.observed.quality, 4);
  assert.equal(r.predicted.score, 7.3);
  assert.equal(r.predicted.faceFt, 5.2);   // 1.6 m in feet, rounded
  assert.equal(r.predicted.windKind, "offshore");
  assert.equal(r.modelVersion, "test");
});

test("a report without a prediction still works", () => {
  const r = buildReport(input, spot, null, { now });
  assert.equal(r.predicted, null);
  assert.equal(compare(r), null);
  assert.match(reportBody(r), /Not captured/);
});

test("compare puts the person's 1-5 rating on the app's 0-10 scale", () => {
  const r = buildReport(input, spot, prediction, { now });   // quality 4 -> 7.5 vs app 7.3
  assert.equal(compare(r).verdict, "match");
  const poor = buildReport({ ...input, quality: "1" }, spot, prediction, { now });
  assert.equal(compare(poor).verdict, "app too high");
});

test("the email body ends with a machine-readable copy of the report", () => {
  const r = buildReport(input, spot, prediction, { now });
  const last = reportBody(r).split("\n").pop();
  assert.ok(last.startsWith("DATA "));
  assert.deepEqual(JSON.parse(last.slice(5)), r);
});

test("mailto links are built, and refused when too long for email apps", () => {
  const r = buildReport(input, spot, prediction, { now });
  const url = mailtoUrl("reports@example.com", r);
  assert.ok(url.startsWith("mailto:reports%40example.com?subject=Surf%20report"));
  assert.equal(mailtoUrl("", Array(20).fill(r)), null);
});

test("CSV escapes quotes and commas in notes", () => {
  const r = buildReport(input, spot, prediction, { now });
  const csv = reportsToCSV([r]);
  const [head, row] = csv.trim().split("\r\n");
  assert.ok(head.startsWith("report_id,created_at"));
  assert.ok(row.includes('"Left off the point, ""fun"" on mid tide"'));
});

test("the email gives local time with its zone, plus UTC", () => {
  const r = buildReport(input, spot, prediction, { now });
  assert.match(reportBody(r, { timeZone: "America/Los_Angeles" }), /When: Sat, Nov 7, 9:00 AM PST \(2026-11-07 17:00 UTC\)/);
});
