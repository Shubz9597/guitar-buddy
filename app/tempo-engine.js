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

  // Missed attacks create longer gaps; they do not make the real attack period
  // shorter. Seed from the shorter half of the observed gaps, then fold only
  // clear integer multiples back to that observed period. This avoids inventing
  // an arbitrary 1/2 ... 1/8 divisor for normal beginner timing jitter.
  const sorted = [...valid].sort((a, b) => a - b);
  const lowerHalf = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  const initialCenter = median(lowerHalf);

  const normalizeAround = (center, tolerance) =>
    valid
      .map((interval) => {
        const missedAttacks = Math.max(
          1,
          Math.min(8, Math.round(interval / center)),
        );
        const normalizedInterval = interval / missedAttacks;
        const relativeError =
          Math.abs(normalizedInterval - center) / Math.max(center, 1);
        return {
          interval: normalizedInterval,
          weight: missedAttacks,
          relativeError,
        };
      })
      .filter((sample) => sample.relativeError <= tolerance);

  const firstPass = normalizeAround(initialCenter, 0.28);
  const refinedCenter =
    firstPass.length > 0
      ? median(firstPass.map((sample) => sample.interval))
      : median(valid);
  const refinedSamples = normalizeAround(refinedCenter, 0.22);
  const usable =
    refinedSamples.length > 0
      ? refinedSamples
      : valid.map((interval) => ({
          interval,
          weight: 1,
          relativeError: 0,
        }));
  const intervalMs = median(usable.map((sample) => sample.interval));
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
 * Finds the repeating attack pulse in a uniformly sampled onset envelope.
 * Unlike counting threshold crossings, autocorrelation is tolerant of missed
 * notes, chord-string transients, and quieter repeats from a processed guitar.
 *
 * The shortest strong correlation peak is the musical attack period. Longer
 * peaks are normally accents (for example, every second sixteenth note), while
 * short effect echoes do not repeat strongly enough to pass the peak ratio.
 *
 * @param {number[]} onsetEnvelope
 * @param {number} sampleIntervalMs
 * @param {number} attacksPerBeat
 * @returns {TempoEstimate | null}
 */
export function estimatePulseTempo(
  onsetEnvelope,
  sampleIntervalMs,
  attacksPerBeat,
) {
  if (
    !Array.isArray(onsetEnvelope) ||
    onsetEnvelope.length < 64 ||
    !Number.isFinite(sampleIntervalMs) ||
    sampleIntervalMs <= 0 ||
    !Number.isFinite(attacksPerBeat) ||
    attacksPerBeat <= 0
  ) {
    return null;
  }

  const rawValues = onsetEnvelope.map((value) =>
    Number.isFinite(value) ? value : 0,
  );
  // A narrow three-frame blur makes a pulse that falls between analyser polls
  // correlate at its real fractional period instead of only at 2x the period.
  const values = rawValues.map((value, index) => {
    const before = index > 0 ? rawValues[index - 1] : value;
    const after = index + 1 < rawValues.length ? rawValues[index + 1] : value;
    return before * 0.25 + value * 0.5 + after * 0.25;
  });
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const totalEnergy = centered.reduce(
    (sum, value) => sum + value * value,
    0,
  );
  if (totalEnergy <= 1e-10) return null;

  const minimumBpm = 30;
  const maximumBpm = 300;
  const minimumLag = Math.max(
    2,
    Math.ceil(60000 / (maximumBpm * attacksPerBeat * sampleIntervalMs)),
  );
  // At least three periods must fit in the window. Correlations based on only
  // one or two repetitions are too easy to create with an isolated noise hit.
  const maximumLag = Math.min(
    centered.length - 2,
    Math.floor(centered.length / 3),
    Math.floor(60000 / (minimumBpm * attacksPerBeat * sampleIntervalMs)),
  );
  if (maximumLag <= minimumLag) return null;

  const correlations = new Float64Array(maximumLag + 1);
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = lag; index < centered.length; index += 1) {
      const left = centered[index - lag];
      const right = centered[index];
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy);
    correlations[lag] = denominator > 1e-10 ? correlation / denominator : 0;
  }

  const peaks = [];
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const score = correlations[lag];
    const before =
      lag === minimumLag ? Number.NEGATIVE_INFINITY : correlations[lag - 1];
    const after =
      lag === maximumLag ? Number.NEGATIVE_INFINITY : correlations[lag + 1];
    if (score > 0 && score > before && score >= after) {
      peaks.push({ lag, score });
    }
  }
  if (peaks.length === 0) return null;

  const strongestScore = Math.max(...peaks.map((peak) => peak.score));
  if (strongestScore < 0.08) return null;

  const strongPeakFloor = Math.max(0.06, strongestScore * 0.68);
  const selected = peaks
    .filter((peak) => peak.score >= strongPeakFloor)
    .sort((left, right) => left.lag - right.lag)[0];
  if (!selected) return null;

  // Parabolic interpolation removes most of the 8 ms analyser-frame rounding.
  let refinedLag = selected.lag;
  if (selected.lag > minimumLag && selected.lag < maximumLag) {
    const before = correlations[selected.lag - 1];
    const center = correlations[selected.lag];
    const after = correlations[selected.lag + 1];
    const denominator = before - 2 * center + after;
    if (Math.abs(denominator) > 1e-10) {
      const adjustment = Math.max(
        -0.5,
        Math.min(0.5, (0.5 * (before - after)) / denominator),
      );
      refinedLag += adjustment;
    }
  }

  const intervalMs = refinedLag * sampleIntervalMs;
  const durationScore = Math.min(
    1,
    (onsetEnvelope.length * sampleIntervalMs) / 8000,
  );
  const correlationScore = Math.max(
    0,
    Math.min(1, (selected.score - 0.06) / 0.3),
  );
  const harmonicScore = Math.min(1, selected.score / strongestScore);
  const confidence = Math.round(
    (0.25 + correlationScore * 0.75) *
      (0.55 + durationScore * 0.45) *
      (0.75 + harmonicScore * 0.25) *
      100,
  );

  return {
    bpm: 60000 / (intervalMs * attacksPerBeat),
    confidence: Math.min(100, confidence),
    intervalMs,
    offsets: [],
  };
}

/**
 * Returns true only when the middle spectral-flux sample is a local peak above
 * the adaptive threshold. This produces one onset candidate on the descending
 * edge instead of producing one candidate on every above-threshold frame.
 *
 * @param {number} beforeFlux
 * @param {number} peakFlux
 * @param {number} afterFlux
 * @param {number} threshold
 * @param {number} rms
 * @param {number} minimumRms
 * @returns {boolean}
 */
export function isSpectralFluxPeak(
  beforeFlux,
  peakFlux,
  afterFlux,
  threshold,
  rms,
  minimumRms,
) {
  return (
    [beforeFlux, peakFlux, afterFlux, threshold, rms, minimumRms].every(
      Number.isFinite,
    ) &&
    peakFlux > threshold &&
    peakFlux > beforeFlux &&
    peakFlux >= afterFlux &&
    rms > minimumRms
  );
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
