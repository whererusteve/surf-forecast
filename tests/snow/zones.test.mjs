import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRing, munterHours, rescaleHours, fmtHours, accessSummary } from "../../snow/js/zones.js";

test("decodeRing walks the steps from the zone centre", () => {
  const ring = decodeRing([50.0, -122.9], [10, 0, 0, 5, -10, 0]);
  assert.deepEqual(ring, [[50.0, -122.899], [50.0005, -122.899], [50.0005, -122.9]]);
});

test("Munter: 1 unit per km plus 1 per 100 m climbed, 4 units an hour", () => {
  assert.equal(munterHours(4, 0), 1);
  assert.equal(munterHours(0, 400), 1);
  assert.equal(munterHours(6, 1000), 4);       // 6 km + 1000 m = 16 units
  assert.equal(munterHours(6, 1000, 3), 16 / 3);
});

test("a slower pace only stretches the skinning part, not the sled ride", () => {
  // 3 h total, 1 h of it on a sled; at 3 units/h the 2 h of skinning becomes 2.67 h
  assert.ok(Math.abs(rescaleHours(3, 1, 3) - (1 + 8 / 3)) < 1e-9);
  assert.equal(rescaleHours(2, 0, 4), 2);
});

test("hours read like a person would say them", () => {
  assert.equal(fmtHours(2.5), "2 h 30 min");
  assert.equal(fmtHours(0.3), "15 min");
  assert.equal(fmtHours(3), "3 h");
});

test("access summary names the legs", () => {
  const s = accessSummary("sled", { h: 3.5, sledKm: 22, sledH: 1.1, km: 4.2, up: 900 });
  assert.match(s, /^Sled 22 km, ~1 h · skin 4.2 km and 900 m up, ~2 h 30 min$/);
  const l = accessSummary("lift", { h: 2.2, km: 3, up: 400 }, 1);
  assert.match(l, /^Lifts \(~1 h\), then skin 3 km and 400 m up, ~1 h 15 min\./);
});

import { bestAccess, aspectName, windDirs } from "../../snow/js/zones.js";

const zone = { acc: {
  skin: { h: 4, km: 8, up: 1000 },
  sled: { h: 2, sledH: 1, sledKm: 20, km: 2, up: 400 },
  lift: { h: 2.5, gate: 0, km: 3, up: 200 },
} };
const gates = [{ rideHours: 1 }];

test("best access picks the quickest allowed mode within the time limit", () => {
  assert.deepEqual(bestAccess(zone, { gates }), { mode: "sled", h: 2 });
  assert.deepEqual(bestAccess(zone, { modes: ["skin"], gates }), { mode: "skin", h: 4 });
  assert.equal(bestAccess(zone, { modes: ["skin"], maxH: 3, gates }), null);
});

test("a slower pace can change which mode is quickest", () => {
  // at 2 units/h: skin 8 h, sled 1 + 2 = 3 h, lift 1 + 3 = 4 h
  assert.deepEqual(bestAccess(zone, { rate: 2, gates }), { mode: "sled", h: 3 });
  assert.deepEqual(bestAccess(zone, { modes: ["skin", "lift"], rate: 2, gates }), { mode: "lift", h: 4 });
});

test("aspects and wind directions read as compass points", () => {
  assert.equal(aspectName(350), "N");
  assert.equal(aspectName(225), "SW");
  assert.deepEqual(windDirs("00136910"), { strong: ["S", "SW"], some: ["SE"] });
});

import { atesSummary } from "../../snow/js/zones.js";

test("AutoATES mix reads in plain words, and extreme terrain is never hidden", () => {
  assert.equal(atesSummary(undefined), null);
  assert.deepEqual(atesSummary([10, 20, 65, 5]), { dominant: 2, text: "Mostly Complex, with some Extreme terrain (5%)" });
  assert.deepEqual(atesSummary([40, 35, 25, 0]), { dominant: 0, text: "Simple and Challenging" });
  assert.equal(atesSummary([20, 15, 30, 35]).text, "Extreme and Complex");
  assert.equal(atesSummary([100, 0, 0, 0]).text, "Mostly Simple");
});
