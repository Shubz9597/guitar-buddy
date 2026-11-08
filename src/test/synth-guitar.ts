// Synthetic guitar PCM with known attack times, for detector tests.

export interface SynthOptions {
  sampleRate?: number;
  bpm?: number;
  /** Attacks per beat. */
  subdivision?: number;
  durationS?: number;
  firstAttackS?: number;
  amplitude?: number;
  /** Note decay time constant, in seconds. Long values keep strings ringing into the next attack. */
  decayS?: number;
  chord?: boolean;
  /** Alternate down and up strums (string order reverses). */
  alternateStrums?: boolean;
  strumSpreadMs?: number;
  palmMuted?: boolean;
  /** Every second attack is this much quieter (0..1). */
  accentRatio?: number;
  /** Fixed per-attack timing offsets in ms, cycled. */
  jitterMs?: number[];
  /** Attack indexes to leave out (rests). */
  skip?: Set<number>;
  stopAtS?: number;
  /** Play a single long note only. */
  sustain?: boolean;
  vibrato?: boolean;
  /** tanh drive amount; 0 disables distortion. */
  drive?: number;
  echo?: { delayMs: number; gain: number };
  humAmplitude?: number;
  hissAmplitude?: number;
  /** Cycle of fret frequencies for single notes. */
  notes?: number[];
}

export interface SynthResult {
  audio: Float32Array;
  sampleRate: number;
  /** Ground-truth attack times in ms (first string for chords). */
  attacksMs: number[];
}

const OPEN_E_CHORD = [82.41, 123.47, 164.81, 207.65, 246.94, 329.63];

export function synthGuitar(options: SynthOptions = {}): SynthResult {
  const {
    sampleRate = 48000,
    bpm = 100,
    subdivision = 2,
    durationS = 8,
    firstAttackS = 0.3,
    amplitude = 0.25,
    decayS = 0.12,
    chord = false,
    alternateStrums = false,
    strumSpreadMs = 5,
    palmMuted = false,
    accentRatio = 1,
    jitterMs = [0],
    skip = new Set<number>(),
    stopAtS = durationS,
    sustain = false,
    vibrato = false,
    drive = 0,
    echo,
    humAmplitude = 0,
    hissAmplitude = 0,
    notes = [82.41],
  } = options;

  const audio = new Float32Array(Math.ceil(durationS * sampleRate));
  const attacksMs: number[] = [];
  const periodS = 60 / (bpm * subdivision);
  let seed = 7;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };

  const pluck = (startS: number, frequency: number, gain: number) => {
    const start = Math.round(startS * sampleRate);
    const decay = palmMuted ? Math.min(decayS, 0.04) : decayS;
    const length = Math.min(audio.length - start, Math.ceil(decay * 8 * sampleRate));
    const harmonics = palmMuted ? 4 : 10;
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate;
      const envelope = (1 - Math.exp(-t / 0.0008)) * Math.exp(-t / decay);
      const phase = 2 * Math.PI * frequency * t + (vibrato ? 0.4 * Math.sin(2 * Math.PI * 5.5 * t) : 0);
      let wave = 0;
      for (let h = 1; h <= harmonics; h += 1) {
        // Higher harmonics decay faster, like a real string.
        wave += (Math.sin(h * phase) / h) * Math.exp(-t * h * 3);
      }
      // Pick noise burst.
      wave += noise() * Math.exp(-t / 0.004) * 0.5;
      audio[start + i] += gain * envelope * wave;
    }
  };

  for (let index = 0, beatS = firstAttackS; beatS < stopAtS - 0.1; index += 1, beatS += periodS) {
    if (skip.has(index)) continue;
    const onsetS = beatS + jitterMs[index % jitterMs.length] / 1000;
    const gain = amplitude * (index % 2 === 1 ? accentRatio : 1);
    attacksMs.push(onsetS * 1000);
    if (chord) {
      const strings = alternateStrums && index % 2 === 1 ? [...OPEN_E_CHORD].reverse() : OPEN_E_CHORD;
      strings.forEach((frequency, string) =>
        pluck(onsetS + (string * strumSpreadMs) / 1000, frequency, gain / 3),
      );
    } else {
      pluck(onsetS, notes[index % notes.length], gain);
    }
    if (sustain) break;
  }

  if (echo) {
    const delay = Math.round((echo.delayMs / 1000) * sampleRate);
    for (let i = audio.length - 1; i >= delay; i -= 1) audio[i] += audio[i - delay] * echo.gain;
  }
  if (drive > 0) {
    const norm = Math.tanh(drive);
    for (let i = 0; i < audio.length; i += 1) audio[i] = Math.tanh(audio[i] * drive * 4) / norm / 4;
  }
  for (let i = 0; i < audio.length; i += 1) {
    if (humAmplitude) audio[i] += humAmplitude * Math.sin((2 * Math.PI * 50 * i) / sampleRate);
    if (hissAmplitude) audio[i] += hissAmplitude * noise();
  }
  return { audio, sampleRate, attacksMs };
}
