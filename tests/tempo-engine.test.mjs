import assert from "node:assert/strict";
import test from "node:test";
import {
  clickIntervalSeconds,
  clampBpm,
  createClickPattern,
  cycleStepState,
  estimateTempo,
  isAttackBurstStart,
  isLikelyEffectRepeat,
  isSpectralFluxPeak,
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

test("does not invent a fast divisor for realistic 50 BPM quarter notes", () => {
  const estimate = estimateTempo([1120, 1280, 1160, 1250, 1190], 1);
  assert.ok(estimate);
  assert.ok(estimate.bpm > 48 && estimate.bpm < 52);
});

test("keeps realistic 60 BPM quarter and eighth notes near 60", () => {
  const quarterNotes = estimateTempo([930, 1060, 970, 1040, 990], 1);
  const eighthNotes = estimateTempo([470, 530, 485, 520, 495], 2);
  assert.ok(quarterNotes);
  assert.ok(eighthNotes);
  assert.ok(quarterNotes.bpm > 58 && quarterNotes.bpm < 62);
  assert.ok(eighthNotes.bpm > 58 && eighthNotes.bpm < 62);
});

test("stays accurate across every subdivision and common practice tempo", () => {
  const jitter = [0.93, 1.06, 0.97, 1.04, 0.99, 1.02, 0.96];

  for (const expectedBpm of [40, 50, 60, 80, 100, 120, 160]) {
    for (const attacksPerBeat of [1, 2, 3, 4]) {
      const idealInterval = 60000 / (expectedBpm * attacksPerBeat);
      const intervals = jitter.map((factor) => idealInterval * factor);
      const estimate = estimateTempo(intervals, attacksPerBeat);
      assert.ok(estimate);
      assert.ok(
        Math.abs(estimate.bpm - expectedBpm) / expectedBpm < 0.03,
        `${expectedBpm} BPM at ${attacksPerBeat} attacks/beat became ${estimate.bpm}`,
      );
    }
  }
});

test("does not pull a rushing performance back toward the practice target", () => {
  const estimate = estimateTempo([280, 280, 280, 280, 380], 4);
  assert.ok(estimate);
  assert.ok(estimate.bpm > 53);
});

test("uses the selected musical subdivision", () => {
  const quarterNotes = estimateTempo([600, 600, 600, 600], 1);
  const eighthNotes = estimateTempo([300, 300, 300, 300], 2);
  const triplets = estimateTempo([200, 200, 200, 200], 3);
  const sixteenths = estimateTempo([150, 150, 150, 150], 4);
  assert.ok(quarterNotes);
  assert.ok(eighthNotes);
  assert.ok(triplets);
  assert.ok(sixteenths);
  assert.equal(quarterNotes.bpm, eighthNotes.bpm);
  assert.equal(quarterNotes.bpm, triplets.bpm);
  assert.equal(quarterNotes.bpm, sixteenths.bpm);
});

test("calculates quarter and eighth note BPM correctly at 50 BPM", () => {
  const quarterNotes = estimateTempo([1200, 1200, 1200, 1200], 1);
  const eighthNotes = estimateTempo([600, 600, 600, 600], 2);
  assert.ok(quarterNotes);
  assert.ok(eighthNotes);
  assert.equal(quarterNotes.bpm, 50);
  assert.equal(eighthNotes.bpm, 50);
});

test("schedules quarter, eighth, triplet, and sixteenth clicks at 50 BPM", () => {
  assert.equal(clickIntervalSeconds(50, 1), 1.2);
  assert.equal(clickIntervalSeconds(50, 2), 0.6);
  assert.equal(clickIntervalSeconds(50, 3), 0.4);
  assert.equal(clickIntervalSeconds(50, 4), 0.3);
});

test("reads 150 ms sixteenth notes as 100 BPM", () => {
  const estimate = estimateTempo([150, 150, 150, 150, 150, 150], 4);
  assert.ok(estimate);
  assert.equal(estimate.bpm, 100);
  assert.equal(estimate.confidence, 100);
});

test("keeps sixteenth-note BPM when several attacks are missed", () => {
  const estimate = estimateTempo(
    [151, 299, 150, 450, 148, 602, 302, 897],
    4,
  );
  assert.ok(estimate);
  assert.ok(Math.abs(estimate.bpm - 100) < 1);
  assert.ok(estimate.confidence >= 90);
});

test("does not fold genuine double-speed sixteenths back to the target", () => {
  const estimate = estimateTempo([75, 75, 75, 75, 75, 75], 4);
  assert.ok(estimate);
  assert.equal(estimate.bpm, 200);
});

test("reports fast strumming even while the practice tempo is 60 BPM", () => {
  const estimate = estimateTempo([250, 250, 250, 250, 250, 250], 1);
  assert.ok(estimate);
  assert.equal(estimate.bpm, 240);
});

test("uses separate burst windows for picking and rhythm strumming", () => {
  assert.equal(minimumAttackSpacingMs("pick"), 42);
  assert.equal(minimumAttackSpacingMs("rhythm"), 90);
});

test("groups the string transients from one chord into one rhythm strum", () => {
  const candidates = [1000, 1028, 1059, 1090];
  let previousCandidate = null;
  const accepted = candidates.filter((timeMs) => {
    const isStart = isAttackBurstStart(
      timeMs,
      previousCandidate,
      "rhythm",
    );
    previousCandidate = timeMs;
    return isStart;
  });

  assert.deepEqual(accepted, [1000]);
  assert.equal(isAttackBurstStart(1200, previousCandidate, "rhythm"), true);
  assert.equal(isAttackBurstStart(1300, 1200, "rhythm"), true);
});

test("pick mode still accepts separate fast note attacks", () => {
  assert.equal(isAttackBurstStart(1050, 1000, "pick"), true);
  assert.equal(isAttackBurstStart(1030, 1000, "pick"), false);
});

test("emits an onset candidate only at a spectral-flux peak", () => {
  assert.equal(isSpectralFluxPeak(2, 8, 4, 5, 0.02, 0.01), true);
  assert.equal(isSpectralFluxPeak(2, 4, 8, 3, 0.02, 0.01), false);
  assert.equal(isSpectralFluxPeak(2, 8, 4, 9, 0.02, 0.01), false);
  assert.equal(isSpectralFluxPeak(2, 8, 4, 5, 0.005, 0.01), false);
});

test("rejects a weak effect repeat but keeps a new full-strength pick", () => {
  assert.equal(isLikelyEffectRepeat(300, 0.1, 1), true);
  assert.equal(isLikelyEffectRepeat(300, 0.8, 1), false);
  assert.equal(isLikelyEffectRepeat(1000, 0.1, 1), false);
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
