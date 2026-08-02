import assert from "node:assert/strict";
import test from "node:test";
import {
  clampBpm,
  createClickPattern,
  cycleStepState,
  estimateTempo,
  isLikelyEffectRepeat,
  median,
  minimumAttackSpacingMs,
  nearestTimingErrorMs,
  parseBpmDraft,
  subdivisionIntervalMs,
} from "../app/tempo-engine.js";

test("calculates a median for odd and even samples", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("reads 300 ms eighth notes as 100 BPM", () => {
  const estimate = estimateTempo([300, 300, 300, 300, 300, 300], 2);
  assert.ok(estimate);
  assert.equal(estimate.bpm, 100);
  assert.equal(estimate.confidence, 100);
});

test("tolerates timing jitter and one missed attack", () => {
  const estimate = estimateTempo([302, 294, 306, 600, 299, 303, 297], 2);
  assert.ok(estimate);
  assert.ok(Math.abs(estimate.bpm - 100) < 1);
  assert.ok(estimate.confidence >= 90);
});

test("uses the selected musical subdivision", () => {
  const quarterNotes = estimateTempo([600, 600, 600, 600], 1);
  const eighthNotes = estimateTempo([300, 300, 300, 300], 2);
  assert.ok(quarterNotes);
  assert.ok(eighthNotes);
  assert.equal(quarterNotes.bpm, eighthNotes.bpm);
});

test("reads 150 ms sixteenth notes as 100 BPM", () => {
  const estimate = estimateTempo([150, 150, 150, 150, 150, 150], 4, 100);
  assert.ok(estimate);
  assert.equal(estimate.bpm, 100);
  assert.equal(estimate.confidence, 100);
});

test("keeps sixteenth-note BPM when several attacks are missed", () => {
  const estimate = estimateTempo(
    [151, 299, 150, 450, 148, 602, 302, 897],
    4,
    100,
  );
  assert.ok(estimate);
  assert.ok(Math.abs(estimate.bpm - 100) < 1);
  assert.ok(estimate.confidence >= 90);
});

test("does not fold genuine double-speed sixteenths back to the target", () => {
  const estimate = estimateTempo([75, 75, 75, 75, 75, 75], 4, 100);
  assert.ok(estimate);
  assert.equal(estimate.bpm, 200);
});

test("guards slow sixteenths against a second transient from one pick", () => {
  assert.equal(subdivisionIntervalMs(50, 4), 300);
  assert.equal(minimumAttackSpacingMs(50, 4), 195);
  assert.ok(160 < minimumAttackSpacingMs(50, 4));
  assert.ok(300 > minimumAttackSpacingMs(50, 4));
});

test("rejects a weak effect repeat but keeps a new full-strength pick", () => {
  assert.equal(isLikelyEffectRepeat(300, 300, 0.3, 1), true);
  assert.equal(isLikelyEffectRepeat(300, 300, 0.8, 1), false);
  assert.equal(isLikelyEffectRepeat(1000, 300, 0.3, 1), false);
});

test("calculates the selected subdivision grid", () => {
  assert.equal(subdivisionIntervalMs(100, 1), 600);
  assert.equal(subdivisionIntervalMs(100, 2), 300);
  assert.equal(subdivisionIntervalMs(100, 4), 150);
});

test("reports signed early and late timing errors", () => {
  assert.equal(nearestTimingErrorMs(1288, 1000, 100, 2), -12);
  assert.equal(nearestTimingErrorMs(1318, 1000, 100, 2), 18);
  assert.equal(nearestTimingErrorMs(1595, 1000, 100, 2), -5);
});

test("creates a click pattern for any meter and rhythm grid", () => {
  assert.deepEqual(createClickPattern(4, 1), [2, 1, 1, 1]);
  assert.equal(createClickPattern(3, 4).length, 12);
  assert.deepEqual(createClickPattern(2, 3), [2, 1, 1, 1, 1, 1]);
});

test("cycles a rhythm step through normal, accent, and mute", () => {
  assert.equal(cycleStepState(1), 2);
  assert.equal(cycleStepState(2), 0);
  assert.equal(cycleStepState(0), 1);
});

test("commits BPM text only after normal typing is complete", () => {
  assert.equal(parseBpmDraft("120", 100), 120);
  assert.equal(parseBpmDraft("", 100), 100);
  assert.equal(parseBpmDraft("1", 100), 30);
  assert.equal(parseBpmDraft("500", 100), 240);
  assert.equal(clampBpm(99.6), 100);
});
