import assert from "node:assert/strict";
import test from "node:test";
import { estimateTempo, median } from "../app/tempo-engine.js";

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
