import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dangerLevel, dangerLabel, fromAvCan, fromAvalancheOrg, forecastStatus, problemsForZone, zoneLevel,
  needsCaution, fill, pointInGeometry,
} from "../../snow/js/hazard.js";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("danger words become levels; anything else is 'no rating', never a guess", () => {
  assert.equal(dangerLevel("considerable"), 3);
  assert.equal(dangerLevel("Extreme"), 5);
  assert.equal(dangerLevel("earlyseason"), 0);
  assert.equal(dangerLevel("norating"), 0);
  assert.equal(dangerLevel(-1), 0);
  assert.equal(dangerLevel(4), 4);
  assert.equal(dangerLabel(3), "3 - Considerable");
  assert.equal(dangerLabel(0), "No rating");
});

test("Avalanche Canada's early-season bulletin reads as early season, with no levels", () => {
  const f = fromAvCan(fx("avcan-early-season.json"));
  assert.equal(f.source, "Avalanche Canada");
  assert.ok(f.url.startsWith("https://avalanche.ca/forecasts/"));
  assert.equal(f.earlySeason, true);
  assert.ok(f.days.length >= 1);
  assert.equal(f.days[0].ratings.alp.level, 0);
  assert.equal(f.days[0].ratings.alp.text, "Early Season");
  assert.equal(zoneLevel(f, 2), 0);
});

test("a forecast with problems: type, where, likelihood and size, but no bulletin text", () => {
  const f = fromAvCan(fx("avcan-parks-banff.json"));
  assert.equal(f.source, "Parks Canada");
  assert.equal(f.problems.length, 1);
  const p = f.problems[0];
  assert.equal(p.type, "Wind Slab");
  assert.deepEqual(p.elevations, ["alp"]);
  assert.deepEqual(p.aspects.sort(), ["e", "n", "ne", "se"]);
  assert.equal(p.likelihood, "unlikely");
  assert.deepEqual(p.size, [1, 1.5]);
  assert.ok(!JSON.stringify(f).includes("Isolated small wind slabs"), "bulletin text must not be copied");
});

test("problems are matched to the zone's band and the way it faces", () => {
  const f = fromAvCan(fx("avcan-parks-banff.json"));
  const alpineNE = problemsForZone(f, 2, "NE")[0];
  assert.equal(alpineNE.inBand, true);
  assert.equal(alpineNE.aspectMatch, true);
  const treelineSW = problemsForZone(f, 1, "SW")[0];
  assert.equal(treelineSW.inBand, false);
  assert.equal(treelineSW.aspectMatch, false);
});

test("in-season ratings: the zone's band on the first day drives the caution message", () => {
  const product = fx("avcan-parks-banff.json");
  product.report.dangerRatings[0].ratings.alp.rating = { value: "considerable", display: "3 - Considerable" };
  product.report.dangerRatings[0].ratings.tln.rating = { value: "moderate", display: "2 - Moderate" };
  const f = fromAvCan(product);
  assert.equal(f.earlySeason, false);
  assert.equal(zoneLevel(f, 2), 3);
  assert.equal(needsCaution(zoneLevel(f, 2)), true);
  assert.equal(needsCaution(zoneLevel(f, 1)), false);
});

test("an expired forecast is flagged, not shown as current", () => {
  const f = fromAvCan(fx("avcan-parks-banff.json"));   // valid until 2026-11-13 23:00 UTC
  assert.equal(forecastStatus(f, new Date("2026-11-12T12:00:00Z")), "current");
  assert.equal(forecastStatus(f, new Date("2026-11-14T00:00:00Z")), "expired");
  assert.equal(forecastStatus({}, new Date()), "unknown");
});

test("avalanche.org zones: the highest danger only, with the centre's name and link", () => {
  const feat = fx("aorg-west-slopes-north.json").features[0];
  const f = fromAvalancheOrg(feat.properties);
  assert.equal(f.kind, "overall");
  assert.equal(f.source, "Northwest Avalanche Center (NWAC)");
  assert.equal(f.zoneName, "West Slopes North");
  assert.equal(f.overall.level, 0);
  assert.equal(f.earlySeason, true);
  assert.equal(fromAvalancheOrg({ ...feat.properties, danger_level: 4 }).overall.text, "High");
});

test("a Mt Baker zone falls inside NWAC's West Slopes North, and Vancouver doesn't", () => {
  const g = fx("aorg-west-slopes-north.json").features[0].geometry;
  assert.equal(pointInGeometry(-121.81, 48.78, g), true);
  assert.equal(pointInGeometry(-123.12, 49.28, g), false);
});

test("wording placeholders are filled, unknown ones left alone", () => {
  assert.equal(fill("{danger} here, {steep}% steep. {x}", { danger: "Considerable", steep: 40 }), "Considerable here, 40% steep. {x}");
});
