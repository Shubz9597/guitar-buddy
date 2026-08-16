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
 * @returns {TempoEstimate | null}
 */
export function estimateTempo(intervalsMs, attacksPerBeat) {
  const valid = intervalsMs.filter(
    (interval) => Number.isFinite(interval) && interval >= 60 && interval <= 3000,
  );

  if (valid.length === 0 || attacksPerBeat <= 0) return null;

  // Every observed interval can be one attack, or several attack periods when
  // the player misses notes. Score all plausible base intervals from the
  // performance itself. The metronome target is deliberately not an input:
  // playing twice as fast must measure twice as fast.
  const candidates = valid.flatMap((interval) =>
    Array.from({ length: 8 }, (_unused, index) => interval / (index + 1)).filter(
      (candidate) => candidate >= 60,
    ),
  );
  const scoredCandidates = candidates.map((candidate) => {
    const samples = valid.map((interval) => {
      const missedAttacks = Math.max(
        1,
        Math.min(8, Math.round(interval / candidate)),
      );
      const normalizedInterval = interval / missedAttacks;
      const relativeError =
        Math.abs(normalizedInterval - candidate) / candidate;
      return {
        interval: normalizedInterval,
        weight: missedAttacks,
        relativeError,
      };
    });
    const inliers = samples.filter((sample) => sample.relativeError <= 0.22);

    return {
      candidate,
      inliers,
      error:
        inliers.length > 0
          ? median(inliers.map((sample) => sample.relativeError))
          : Number.POSITIVE_INFINITY,
      averageWeight:
        inliers.length > 0
          ? inliers.reduce((sum, sample) => sum + sample.weight, 0) /
            inliers.length
          : Number.POSITIVE_INFINITY,
    };
  });
  scoredCandidates.sort((a, b) => {
    if (a.inliers.length !== b.inliers.length) {
      return b.inliers.length - a.inliers.length;
    }
    if (Math.abs(a.error - b.error) > 0.005) return a.error - b.error;
    return a.averageWeight - b.averageWeight;
  });

  const usable = scoredCandidates[0].inliers;
  const totalWeight = usable.reduce((sum, sample) => sum + sample.weight, 0);
  const intervalMs =
    usable.reduce(
      (sum, sample) => sum + sample.interval * sample.weight,
      0,
    ) / totalWeight;
  const deviations = usable.map((sample) =>
    Math.abs(sample.interval - intervalMs),
  );
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
      .map((sample) =>
        Math.max(
          -1,
          Math.min(
            1,
            (sample.interval - intervalMs) / (intervalMs * 0.2),
          ),
        ),
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
 * Exact interval used by the audible metronome scheduler.
 *
 * @param {number} bpm
 * @param {number} clicksPerBeat
 * @returns {number}
 */
export function clickIntervalSeconds(bpm, clicksPerBeat) {
  return subdivisionIntervalMs(bpm, clicksPerBeat) / 1000;
}

/**
 * Tiny fixed guard against analysing the same physical attack twice. It must
 * never depend on the practice BPM or selected subdivision, because that would
 * impose a hidden maximum on measured playing speed.
 *
 * @param {"pick" | "rhythm"} [practiceMode]
 * @returns {number}
 */
export function minimumAttackSpacingMs(practiceMode = "pick") {
  return practiceMode === "rhythm" ? 90 : 42;
}

/**
 * A chord strum creates several closely spaced string transients. Compare each
 * candidate with the immediately previous candidate (accepted or rejected), so
 * the entire string-by-string burst remains one attack until there is a quiet
 * gap. Pick mode keeps the shortest safe gap for individual-note speed.
 *
 * @param {number} timeMs
 * @param {number | null} previousCandidateMs
 * @param {"pick" | "rhythm"} practiceMode
 * @returns {boolean}
 */
export function isAttackBurstStart(
  timeMs,
  previousCandidateMs,
  practiceMode,
) {
  if (!Number.isFinite(timeMs)) return false;
  if (previousCandidateMs === null || !Number.isFinite(previousCandidateMs)) {
    return true;
  }

  return (
    timeMs - previousCandidateMs >= minimumAttackSpacingMs(practiceMode)
  );
}

/**
 * Delay, reverb, and compression can produce a quieter copy of a real attack.
 * Treat a substantially weaker transient inside the musical repeat window as
 * an effect repeat. Real notes with similar strength remain eligible.
 *
 * @param {number} intervalMs
 * @param {number} currentStrength
 * @param {number} previousStrength
 * @returns {boolean}
 */
export function isLikelyEffectRepeat(
  intervalMs,
  currentStrength,
  previousStrength,
) {
  if (
    !Number.isFinite(intervalMs) ||
    !Number.isFinite(currentStrength) ||
    !Number.isFinite(previousStrength) ||
    intervalMs <= 0 ||
    currentStrength < 0 ||
    previousStrength <= 0
  ) {
    return false;
  }

  const repeatWindowMs = 700;
  const fadingStrengthRatio =
    0.2 * (1 - 0.35 * Math.min(1, intervalMs / repeatWindowMs));
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
