/**
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * @typedef {{
 *   bpm: number;
 *   confidence: number;
 *   intervalMs: number;
 *   offsets: number[];
 * }} TempoEstimate
 */

/**
 * @param {number[]} intervalsMs
 * @param {number} attacksPerBeat
 * @param {number} [referenceBpm]
 * @returns {TempoEstimate | null}
 */
export function estimateTempo(intervalsMs, attacksPerBeat, referenceBpm) {
  const valid = intervalsMs.filter(
    (interval) => Number.isFinite(interval) && interval >= 60 && interval <= 3000,
  );

  if (valid.length === 0 || attacksPerBeat <= 0) return null;

  const referenceInterval = subdivisionIntervalMs(
    Number(referenceBpm),
    attacksPerBeat,
  );
  const initialCenter = referenceInterval || median(valid);
  const normalized = valid.map((interval) => {
    const missedAttacks = Math.round(interval / initialCenter);
    if (
      missedAttacks >= 2 &&
      missedAttacks <= 8 &&
      Math.abs(interval / missedAttacks - initialCenter) <= initialCenter * 0.45
    ) {
      return interval / missedAttacks;
    }

    if (
      !referenceInterval &&
      interval < initialCenter * 0.68 &&
      interval * 2 < initialCenter * 1.45
    ) {
      return interval * 2;
    }

    return interval;
  });

  const center = median(normalized);
  const inliers = normalized.filter(
    (interval) => Math.abs(interval - center) <= center * 0.35,
  );
  const usable = inliers.length > 0 ? inliers : normalized;
  const intervalMs = median(usable);
  const deviations = usable.map((interval) => Math.abs(interval - intervalMs));
  const medianDeviation = median(deviations);
  const stability = Math.max(
    0,
    1 - medianDeviation / Math.max(intervalMs * 0.16, 1),
  );
  const sampleScore = Math.min(1, usable.length / 6);
  const confidence = Math.round(
    (0.25 + stability * 0.75) * (0.35 + sampleScore * 0.65) * 100,
  );

  return {
    bpm: 60000 / (intervalMs * attacksPerBeat),
    confidence: Math.min(100, confidence),
    intervalMs,
    offsets: usable
      .slice(-9)
      .map((interval) =>
        Math.max(-1, Math.min(1, (interval - intervalMs) / (intervalMs * 0.2))),
      ),
  };
}

/**
 * @param {number} bpm
 * @param {number} attacksPerBeat
 * @returns {number}
 */
export function subdivisionIntervalMs(bpm, attacksPerBeat) {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  if (!Number.isFinite(attacksPerBeat) || attacksPerBeat <= 0) return 0;
  return 60000 / (bpm * attacksPerBeat);
}

/**
 * Minimum gap between accepted guitar attacks while coaching against a target.
 * Guitar strings often create a weaker second transient after the real pick;
 * allowing only 65% of the selected note interval rejects that ringing while
 * leaving generous room for a beginner to play early.
 *
 * @param {number} bpm
 * @param {number} attacksPerBeat
 * @returns {number}
 */
export function minimumAttackSpacingMs(bpm, attacksPerBeat) {
  const expectedInterval = subdivisionIntervalMs(bpm, attacksPerBeat);
  if (expectedInterval === 0) return 42;
  return Math.max(42, Math.min(220, expectedInterval * 0.65));
}

/**
 * Delay, reverb, and compression can produce a quieter copy of a real attack.
 * Treat a substantially weaker transient inside the musical repeat window as
 * an effect repeat. Real notes with similar strength remain eligible.
 *
 * @param {number} intervalMs
 * @param {number} expectedIntervalMs
 * @param {number} currentStrength
 * @param {number} previousStrength
 * @returns {boolean}
 */
export function isLikelyEffectRepeat(
  intervalMs,
  expectedIntervalMs,
  currentStrength,
  previousStrength,
) {
  if (
    !Number.isFinite(intervalMs) ||
    !Number.isFinite(expectedIntervalMs) ||
    !Number.isFinite(currentStrength) ||
    !Number.isFinite(previousStrength) ||
    intervalMs <= 0 ||
    expectedIntervalMs <= 0 ||
    currentStrength < 0 ||
    previousStrength <= 0
  ) {
    return false;
  }

  const repeatWindowMs = Math.max(
    600,
    Math.min(1200, expectedIntervalMs * 3),
  );
  const fadingStrengthRatio =
    0.45 * (1 - 0.45 * Math.min(1, intervalMs / repeatWindowMs));
  return (
    intervalMs < repeatWindowMs &&
    currentStrength < previousStrength * fadingStrengthRatio
  );
}

/**
 * Returns a signed error: negative is early and positive is late.
 *
 * @param {number} onsetMs
 * @param {number} gridOriginMs
 * @param {number} bpm
 * @param {number} attacksPerBeat
 * @returns {number}
 */
export function nearestTimingErrorMs(
  onsetMs,
  gridOriginMs,
  bpm,
  attacksPerBeat,
) {
  const intervalMs = subdivisionIntervalMs(bpm, attacksPerBeat);
  if (intervalMs === 0) return 0;
  const nearestStep = Math.round((onsetMs - gridOriginMs) / intervalMs);
  const idealTimeMs = gridOriginMs + nearestStep * intervalMs;
  return onsetMs - idealTimeMs;
}

/**
 * Step states: 0 = muted, 1 = normal, 2 = accent.
 *
 * @param {number} beatsPerBar
 * @param {number} clicksPerBeat
 * @returns {number[]}
 */
export function createClickPattern(beatsPerBar, clicksPerBeat) {
  const beats = Math.max(1, Math.min(12, Math.round(beatsPerBar)));
  const clicks = Math.max(1, Math.min(4, Math.round(clicksPerBeat)));
  return Array.from(
    { length: beats * clicks },
    (_unused, index) => (index === 0 ? 2 : 1),
  );
}

/**
 * @param {number} state
 * @returns {number}
 */
export function cycleStepState(state) {
  if (state === 1) return 2;
  if (state === 2) return 0;
  return 1;
}

/**
 * @param {number} value
 * @returns {number}
 */
export function clampBpm(value) {
  return Math.max(30, Math.min(240, Math.round(value)));
}

/**
 * Allows the UI to keep an empty or partial text draft while typing, then
 * validates it only when the edit is committed.
 *
 * @param {string} draft
 * @param {number} fallback
 * @returns {number}
 */
export function parseBpmDraft(draft, fallback) {
  const trimmed = String(draft).trim();
  if (!/^\d+$/.test(trimmed)) return clampBpm(fallback);
  return clampBpm(Number(trimmed));
}
