export type PlayingStyle = "pick" | "strum";

export interface DetectorSettings {
  /** 1 = only strong attacks, 10 = very quiet notes. */
  sensitivity: number;
  /** Strumming merges the string-by-string transients of a chord into one attack. */
  style: PlayingStyle;
}

export interface Onset {
  /** Attack start on the audio clock, in milliseconds. */
  timeMs: number;
  /** Peak spectral flux of the attack. */
  strength: number;
}

export interface Level {
  rms: number;
  peak: number;
}

const HOP_SECONDS = 0.005;
const LOW_HZ = 50;
const HIGH_HZ = 5000;
// log1p(gain * magnitude) compresses the spectrum so quiet notes still register.
const LOG_GAIN = 300000;
// Per-bin rise ignored as noise, in log-magnitude units.
const BIN_GATE = 0.1;
// Spectral flux is measured against the frame two hops back (10 ms), which
// gives a sharper peak than comparing neighbouring 5 ms frames.
const FLUX_LAG = 2;
// Peak picking: a peak must be the maximum over the previous 30 ms and next
// 10 ms, and stand clear of the 100 ms average around it.
const PRE_MAX = 6;
const POST_MAX = 2;
const AVERAGE = 20;
const HISTORY = 32;
const LEVEL_EVERY = 10;
// Attacks weaker than this share of the recent strongest attack are treated
// as sympathetic noise (scaled by sensitivity); the reference decays over 2 s.
const STRENGTH_MEMORY_S = 2;
const MIN_GAP_MS: Record<PlayingStyle, number> = { pick: 30, strum: 60 };
// How far before the energy peak the refined attack start may lie.
const MAX_RISE_MS: Record<PlayingStyle, number> = { pick: 20, strum: 40 };

/**
 * Finds guitar attacks in raw PCM.
 *
 * Detection uses log-magnitude spectral flux with a max-filtered reference
 * (robust to vibrato and ringing strings). The detected attack is then located
 * to ~1 ms in the time domain, where the high-frequency energy of the pick
 * transient starts to rise. All times come from the sample clock.
 */
export class OnsetDetector {
  onOnset: (onset: Onset) => void = () => {};
  onLevel: (level: Level) => void = () => {};

  readonly sampleRate: number;
  readonly fftSize: number;
  readonly hop: number;

  private readonly ringSize: number;
  private readonly mask: number;
  private rings: Float32Array[] = [];
  private nextFrame = -1;
  private buffered = 0;
  private untilHop: number;
  private channel = 0;
  private settings: DetectorSettings = { sensitivity: 7, style: "pick" };

  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly window: Float64Array;
  private readonly bitReversed: Uint32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly firstBin: number;
  private readonly lastBin: number;
  private readonly spectra: Float64Array[];

  private readonly flux = new Float64Array(HISTORY);
  private readonly rms = new Float64Array(HISTORY);
  private readonly centre = new Float64Array(HISTORY);
  private frames = 0;
  private lastOnsetCentre = -Infinity;
  private lastOnsetSample = -Infinity;
  private recentStrength = 0;

  private levelPeak = 0;
  private levelRms = 0;
  private levelFrames = 0;

  constructor(sampleRate: number, settings?: Partial<DetectorSettings>) {
    this.sampleRate = sampleRate;
    // ~21 ms analysis window at any sample rate.
    this.fftSize = sampleRate > 64000 ? 2048 : 1024;
    this.hop = Math.round(sampleRate * HOP_SECONDS);
    this.ringSize = 1 << Math.ceil(Math.log2(sampleRate * 0.1));
    this.mask = this.ringSize - 1;
    this.untilHop = this.hop;
    if (settings) this.configure(settings);

    const n = this.fftSize;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.window = Float64Array.from(
      { length: n },
      (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n),
    );
    const bits = Math.log2(n);
    this.bitReversed = Uint32Array.from({ length: n }, (_, i) => {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) reversed = (reversed << 1) | ((i >> bit) & 1);
      return reversed;
    });
    this.cosTable = Float64Array.from({ length: n / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / n));
    this.sinTable = Float64Array.from({ length: n / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / n));
    this.firstBin = Math.max(1, Math.floor((LOW_HZ * n) / sampleRate));
    this.lastBin = Math.min(n / 2 - 2, Math.ceil((HIGH_HZ * n) / sampleRate));
    this.spectra = Array.from({ length: FLUX_LAG + 1 }, () => new Float64Array(n / 2));
  }

  configure(settings: Partial<DetectorSettings>) {
    const sensitivity = settings.sensitivity ?? this.settings.sensitivity;
    this.settings = {
      sensitivity: Math.max(1, Math.min(10, sensitivity)),
      style: settings.style ?? this.settings.style,
    };
  }

  reset() {
    this.buffered = 0;
    this.frames = 0;
    this.lastOnsetCentre = -Infinity;
    this.lastOnsetSample = -Infinity;
    this.recentStrength = 0;
    for (const spectrum of this.spectra) spectrum.fill(0);
  }

  /** `startFrame` is the absolute sample index of the first sample in the block. */
  process(channels: readonly Float32Array[], startFrame: number) {
    if (channels.length === 0) return;
    if (this.rings.length !== channels.length) {
      this.rings = channels.map(() => new Float32Array(this.ringSize));
      this.channel = 0;
      this.reset();
    }
    if (startFrame !== this.nextFrame) this.reset();

    const length = channels[0].length;
    for (let i = 0; i < length; i += 1) {
      const slot = (startFrame + i) & this.mask;
      for (let c = 0; c < channels.length; c += 1) {
        const value = channels[c][i] ?? 0;
        this.rings[c][slot] = value;
        const magnitude = Math.abs(value);
        if (magnitude > this.levelPeak) this.levelPeak = magnitude;
      }
      this.buffered += 1;
      this.untilHop -= 1;
      if (this.untilHop === 0) {
        this.untilHop = this.hop;
        if (this.buffered >= this.fftSize) this.analyse(startFrame + i + 1);
      }
    }
    this.nextFrame = startFrame + length;
  }

  private selectChannel(end: number) {
    // Pick the strongest physical channel rather than summing L/R, which can
    // cancel an inverted or single-sided guitar signal.
    if (this.rings.length === 1) return;
    const start = end - this.fftSize;
    let best = this.channel;
    let bestEnergy = 0;
    let currentEnergy = 0;
    for (let c = 0; c < this.rings.length; c += 1) {
      const ring = this.rings[c];
      let energy = 0;
      for (let i = 0; i < this.fftSize; i += 1) {
        const value = ring[(start + i) & this.mask];
        energy += value * value;
      }
      if (c === this.channel) currentEnergy = energy;
      if (energy > bestEnergy) {
        bestEnergy = energy;
        best = c;
      }
    }
    if (best !== this.channel && bestEnergy > currentEnergy * 4) {
      this.channel = best;
      // Rebuild the reference spectra from the new channel's recent audio so
      // the attack that triggered the switch is still detected.
      for (let lag = FLUX_LAG; lag >= 1; lag -= 1) {
        const frame = this.frames - lag;
        if (frame < 0 || this.buffered < this.fftSize + lag * this.hop) continue;
        this.spectrumAt(end - lag * this.hop, this.spectra[frame % this.spectra.length]);
      }
    }
  }

  /** Writes the log-magnitude spectrum of the window ending at `end`; returns its energy. */
  private spectrumAt(end: number, target: Float64Array) {
    const n = this.fftSize;
    const start = end - n;
    const ring = this.rings[this.channel];
    let energy = 0;
    for (let i = 0; i < n; i += 1) {
      const value = ring[(start + i) & this.mask];
      energy += value * value;
      this.re[this.bitReversed[i]] = value * this.window[i];
      this.im[i] = 0;
    }
    this.fft();
    for (let bin = this.firstBin - 1; bin <= this.lastBin + 1; bin += 1) {
      target[bin] = Math.log1p((LOG_GAIN * Math.hypot(this.re[bin], this.im[bin])) / n);
    }
    return energy;
  }

  private fft() {
    const { re, im, cosTable, sinTable } = this;
    const n = this.fftSize;
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k += 1) {
          const left = start + k;
          const right = left + half;
          const wr = cosTable[k * step];
          const wi = sinTable[k * step];
          const tr = re[right] * wr - im[right] * wi;
          const ti = re[right] * wi + im[right] * wr;
          re[right] = re[left] - tr;
          im[right] = im[left] - ti;
          re[left] += tr;
          im[left] += ti;
        }
      }
    }
  }

  private analyse(end: number) {
    const n = this.fftSize;
    this.selectChannel(end);
    const spectrum = this.spectra[this.frames % this.spectra.length];
    const reference = this.spectra[(this.frames + 1) % this.spectra.length];
    const energy = this.spectrumAt(end, spectrum);

    let flux = 0;
    for (let bin = this.firstBin; bin <= this.lastBin; bin += 1) {
      // Max over neighbouring bins: vibrato and bends move energy between
      // adjacent bins without a new attack.
      const previous = Math.max(reference[bin - 1], reference[bin], reference[bin + 1]);
      const rise = spectrum[bin] - previous - BIN_GATE;
      if (rise > 0) flux += rise;
    }
    flux /= this.lastBin - this.firstBin + 1;
    if (this.frames < FLUX_LAG) flux = 0;

    const rms = Math.sqrt(energy / n);
    const slot = this.frames % HISTORY;
    this.flux[slot] = flux;
    this.rms[slot] = rms;
    this.centre[slot] = end - n / 2;
    this.frames += 1;

    this.levelRms = Math.max(this.levelRms, rms);
    this.levelFrames += 1;
    if (this.levelFrames === LEVEL_EVERY) {
      this.onLevel({ rms: this.levelRms, peak: this.levelPeak });
      this.levelRms = 0;
      this.levelPeak = 0;
      this.levelFrames = 0;
    }

    this.pickPeak(end);
  }

  private pickPeak(end: number) {
    const candidate = this.frames - 1 - POST_MAX;
    if (candidate < AVERAGE) return;
    const flux = (frame: number) => this.flux[frame % HISTORY];
    const value = flux(candidate);
    if (value <= 0) return;

    for (let frame = candidate - PRE_MAX; frame < candidate; frame += 1) {
      if (flux(frame) >= value) return;
    }
    for (let frame = candidate + 1; frame <= candidate + POST_MAX; frame += 1) {
      if (flux(frame) > value) return;
    }

    let sum = 0;
    for (let frame = candidate - AVERAGE; frame <= candidate + POST_MAX; frame += 1) {
      sum += flux(frame);
    }
    const average = sum / (AVERAGE + POST_MAX + 1);
    const { sensitivity, style } = this.settings;
    const delta = 0.15 + (10 - sensitivity) * 0.03;
    if (value < average + delta) return;

    // Absolute floor: -80 dBFS at sensitivity 10, -53 dBFS at sensitivity 1.
    const minimumRms = 10 ** ((-80 + 3 * (10 - sensitivity)) / 20);
    let rms = 0;
    for (let frame = candidate; frame <= candidate + POST_MAX; frame += 1) {
      rms = Math.max(rms, this.rms[frame % HISTORY]);
    }
    if (rms < minimumRms) return;

    const centre = this.centre[candidate % HISTORY];
    const minimumGap = (MIN_GAP_MS[style] * this.sampleRate) / 1000;
    if (centre - this.lastOnsetCentre < minimumGap) return;

    const elapsedS = (centre - this.lastOnsetCentre) / this.sampleRate;
    const reference = this.recentStrength * Math.exp(-elapsedS / STRENGTH_MEMORY_S);
    if (value < reference * (0.04 + (10 - sensitivity) * 0.07)) return;

    const attack = this.locateAttack(centre, end, minimumGap);
    this.recentStrength = Math.max(value, reference);
    this.lastOnsetCentre = centre;
    this.lastOnsetSample = attack;
    this.onOnset({ timeMs: (attack * 1000) / this.sampleRate, strength: value });
  }

  /**
   * Finds where the attack's high-frequency energy starts rising, in 1 ms
   * blocks of first-difference energy around the detected flux peak.
   */
  private locateAttack(centre: number, end: number, minimumGap: number) {
    const ring = this.rings[this.channel];
    const block = Math.max(8, Math.round(this.sampleRate / 1000));
    const from = Math.ceil(
      Math.max(
        centre - this.fftSize / 2 - FLUX_LAG * this.hop,
        end - this.ringSize + block,
        this.lastOnsetSample + minimumGap / 2,
      ),
    );
    const blocks = Math.floor((end - from) / block);
    if (blocks < 3) return centre;

    const energies = new Float64Array(blocks);
    let peakBlock = 0;
    for (let j = 0; j < blocks; j += 1) {
      const first = from + j * block;
      let previous = ring[(first - 1) & this.mask];
      let energy = 0;
      for (let k = first; k < first + block; k += 1) {
        const value = ring[k & this.mask];
        const difference = value - previous;
        energy += difference * difference;
        previous = value;
      }
      energies[j] = energy;
      if (energy > energies[peakBlock]) peakBlock = j;
    }

    // The attack starts after the quietest point shortly before the peak, so
    // the previous note's tail is never mistaken for the new attack.
    const maxRise = Math.round(MAX_RISE_MS[this.settings.style]);
    let quietest = Math.max(0, peakBlock - maxRise);
    for (let j = quietest + 1; j < peakBlock; j += 1) {
      if (energies[j] < energies[quietest]) quietest = j;
    }
    const threshold = energies[quietest] + 0.15 * (energies[peakBlock] - energies[quietest]);

    let attackBlock = peakBlock;
    if (this.settings.style === "strum") {
      // A strum's strings can have quiet gaps between them; take the first string.
      for (let j = quietest; j < peakBlock; j += 1) {
        if (energies[j] >= threshold) {
          attackBlock = j;
          break;
        }
      }
    } else {
      while (attackBlock > quietest && energies[attackBlock - 1] >= threshold) attackBlock -= 1;
    }
    return from + attackBlock * block;
  }
}
