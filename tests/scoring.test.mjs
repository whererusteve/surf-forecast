// Run with:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  angleDiff, unpackWindow, exposureAt, windowRanges, breakingHeight,
  windScore, sizeScore, scoreSpot, SIZE_PRESETS,
} from "../app/js/scoring.js";

// A window open from 180 to 300 degrees (bins 36..60)
const bits = Array.from({ length: 72 }, (_, i) => (i >= 36 && i <= 60 ? 1 : 0));
const beach = { facing: 240, ridge: 0, type: "coast", profile: [5, 8, 12, 20, 30, 40, 60], potential: 0.7 };

test("angleDiff wraps around north", () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(90, 270), 180);
});

test("unpackWindow reverses the pipeline's hex packing", () => {
  assert.deepEqual(unpackWindow("f0"), [1, 1, 1, 1, 0, 0, 0, 0]);
  assert.equal(unpackWindow("0".repeat(18)).length, 72);
});

test("exposure is full inside the window and zero far outside", () => {
  assert.equal(exposureAt(bits, 240), 1);
  assert.equal(exposureAt(bits, 90), 0);
  const edge = exposureAt(bits, 305);
  assert.ok(edge > 0 && edge < 1, `edge exposure should be partial, got ${edge}`);
});

test("windowRanges describes the open sectors", () => {
  assert.deepEqual(windowRanges(bits), ["180–300°"]);
  const wrap = Array.from({ length: 72 }, (_, i) => (i >= 66 || i <= 3 ? 1 : 0));
  assert.deepEqual(windowRanges(wrap), ["330–15°"]);
});

test("longer period breaks bigger for the same offshore height", () => {
  assert.ok(breakingHeight(1.5, 16) > breakingHeight(1.5, 8));
  assert.equal(breakingHeight(0, 12), 0);
});

test("offshore wind beats onshore wind", () => {
  const off = windScore(12, 60, 240);  // from ENE onto a WSW-facing beach = offshore
  const on = windScore(12, 240, 240);  // straight onshore
  assert.equal(off.kind, "offshore");
  assert.equal(on.kind, "onshore");
  assert.ok(off.score > on.score);
  assert.equal(windScore(3, 240, 240).kind, "light");
});

test("size score peaks in the ideal range", () => {
  const p = SIZE_PRESETS.fun;
  assert.equal(sizeScore(1.2, p), 1);
  assert.ok(sizeScore(0.3, p) < 0.5);
  assert.ok(sizeScore(5, p) < 0.5);
});

test("a clean groundswell in the window with offshore wind scores high", () => {
  const good = scoreSpot(beach, bits, {
    swells: [{ h: 1.6, t: 14, dir: 245 }], windWave: { h: 0.2, t: 3, dir: 60 }, windKn: 6, windDir: 60,
  }, SIZE_PRESETS.overhead);
  assert.ok(good.score >= 7, `expected >= 7, got ${good.score}`);
});

test("the same swell from a blocked direction scores near zero", () => {
  const blocked = scoreSpot(beach, bits, {
    swells: [{ h: 1.6, t: 14, dir: 90 }], windWave: null, windKn: 6, windDir: 60,
  });
  assert.ok(blocked.score < 1, `expected < 1, got ${blocked.score}`);
});

test("strong onshore wind drags a good swell down", () => {
  const fc = { swells: [{ h: 1.6, t: 14, dir: 245 }], windWave: { h: 1.0, t: 5, dir: 240 } };
  const clean = scoreSpot(beach, bits, { ...fc, windKn: 4, windDir: 60 });
  const blown = scoreSpot(beach, bits, { ...fc, windKn: 22, windDir: 240 });
  assert.ok(blown.score < clean.score / 2, `blown ${blown.score} vs clean ${clean.score}`);
});

test("gale-force wind kills the score even when offshore", () => {
  assert.ok(windScore(45, 60, 240).score < 0.2);
  assert.ok(windScore(15, 60, 240).score > 0.9);
});

test("a shallow estuary approach shrinks the waves", () => {
  const fc = { swells: [{ h: 2, t: 13, dir: 245 }], windWave: null, windKn: 3, windDir: 60 };
  const open = scoreSpot(beach, bits, fc);
  const estuary = scoreSpot({ ...beach, shelf: 0.4 }, bits, fc);
  assert.ok(estuary.face < open.face * 0.6, `estuary ${estuary.face} vs open ${open.face}`);
});
