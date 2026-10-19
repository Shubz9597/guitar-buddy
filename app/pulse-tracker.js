import { estimatePulseTempo, estimateTempo, median } from "./tempo-engine.js";

// Receives uniformly spaced frames captured by GuitarProcessor. Delivery time
// (including delayed/batched messages from a busy UI) is never used as audio time.
export class PulseTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.frames = [];
    this.readings = [];
    this.nextAnalysisMs = 0;
    this.lastOnsetMs = -Infinity;
    this.lastIntervalMs = 2000;
    this.estimate = null;
  }

  push(frame, sampleIntervalMs, attacksPerBeat) {
    if (frame.onset) this.lastOnsetMs = frame.timeMs;
    this.frames.push(frame);
    if (frame.timeMs < this.nextAnalysisMs) return undefined;
    this.nextAnalysisMs = frame.timeMs + 500;
    const cutoff = frame.timeMs - 8000;
    const firstLive = this.frames.findIndex((sample) => sample.timeMs >= cutoff);
    if (firstLive > 0) this.frames.splice(0, firstLive);

    const staleAfterMs = Math.max(1600, this.lastIntervalMs * 2.5);
    if (frame.timeMs - this.lastOnsetMs > staleAfterMs) {
      this.frames = [];
      this.readings = [];
      this.estimate = null;
      return null;
    }
    if (this.frames.length * sampleIntervalMs < 3000) return undefined;
    let estimate = estimatePulseTempo(
      this.frames.map((sample) => sample.envelope),
      sampleIntervalMs,
      attacksPerBeat,
    );
    // Narrow correlation peaks can favour a whole repeating phrase when human
    // timing varies. Independently measured attacks resolve that harmonic when
    // most observed gaps support the same pulse, including integer-length rests.
    const onsets = this.frames.filter((sample) => sample.onset);
    const intervals = onsets.slice(1).map((sample, i) => sample.timeMs - onsets[i].timeMs);
    if (intervals.length >= 4) {
      const attackEstimate = estimateTempo(intervals, attacksPerBeat);
      if (attackEstimate) {
        const coverage = intervals.filter((interval) => {
          const steps = Math.max(1, Math.round(interval / attackEstimate.intervalMs));
          return Math.abs(interval / steps - attackEstimate.intervalMs) < attackEstimate.intervalMs * 0.15;
        }).length / intervals.length;
        if (coverage >= 0.8 && attackEstimate.confidence >= 80) {
          const steps = intervals.reduce((sum, interval) =>
            sum + Math.max(1, Math.round(interval / attackEstimate.intervalMs)), 0);
          const intervalMs = (onsets[onsets.length - 1].timeMs - onsets[0].timeMs) / steps;
          // Use the full timestamp span to remove hop-size quantisation bias
          // (a 62.5 ms interval alternates between 60 and 65 ms frames).
          estimate = { ...attackEstimate, intervalMs, bpm: 60000 / (intervalMs * attacksPerBeat) };
        }
      }
    }
    if (!estimate || estimate.confidence < 45) {
      this.readings = [];
      this.estimate = null;
      return null;
    }
    // A new speed should settle from new evidence rather than blending with
    // the previous speed for several more updates.
    if (this.estimate && Math.abs(estimate.bpm / this.estimate.bpm - 1) > 0.15) {
      this.readings = [];
    }
    this.readings = [...this.readings, estimate.bpm].slice(-3);
    this.lastIntervalMs = estimate.intervalMs;
    this.estimate = { ...estimate, bpm: median(this.readings) };
    return this.estimate;
  }
}
