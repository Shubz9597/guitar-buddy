import assert from "node:assert/strict";
import test from "node:test";
import { PulseTracker } from "../app/pulse-tracker.js";

let Processor;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: (message) => this.messages.push(message) };
    this.messages = [];
  }
};
globalThis.registerProcessor = (_name, implementation) => { Processor = implementation; };
await import("../app/guitar-processor.js");

// Actual PCM through the production processor, not pre-labelled attack times.
function guitar({ rate = 48000, bpm = 100, division = 2, duration = 9,
  amplitude = 0.2, decay = 0.14, chord = false, muted = false,
  dynamics = false, stopAt = duration, hum = 0, sustain = false,
  hiss = 0, vibrato = false, skipped = new Set(), irregular = false } = {}) {
  const audio = new Float32Array(Math.ceil(duration * rate));
  const times = [];
  const period = 60 / (bpm * division);
  let seed = 42;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };
  for (let note = 0, time = 0.3; time < stopAt - 0.1; note += 1, time += period) {
    if (skipped.has(note)) continue;
    const onset = time + (irregular ? [0, 0.012, -0.008, 0.005][note % 4] : 0);
    times.push(onset * 1000);
    const gain = amplitude * (dynamics && note % 2 ? 0.12 : 1);
    const frequencies = chord ? [82.41, 123.47, 164.81, 207.65, 246.94, 329.63] : [82.41];
    frequencies.forEach((frequency, string) => {
      const start = Math.round((onset + string * 0.005) * rate);
      const length = Math.min(audio.length - start, Math.ceil(decay * 7 * rate));
      for (let i = 0; i < length; i += 1) {
        const t = i / rate;
        const envelope = (1 - Math.exp(-t / 0.001)) * Math.exp(-t / decay);
        let wave = 0;
        for (let harmonic = 1; harmonic <= (muted ? 3 : 8); harmonic += 1) {
          const phase = 2 * Math.PI * frequency * t + (vibrato ? 0.3 * Math.sin(2 * Math.PI * 5 * t) : 0);
          wave += Math.sin(harmonic * phase) / harmonic;
        }
        wave += noise() * Math.exp(-t / 0.006) * 0.4;
        audio[start + i] += gain * envelope * wave / frequencies.length;
      }
    });
    if (sustain) break;
  }
  if (hum) {
    for (let i = 0; i < audio.length; i += 1) {
      audio[i] += hum * Math.sin(2 * Math.PI * 50 * i / rate);
    }
  }
  if (hiss) {
    for (let i = 0; i < audio.length; i += 1) audio[i] += hiss * noise();
  }
  return { audio, times, rate };
}

function analyse(fixture, { mode = "pick", stereo = "mono", chunks = [128], division = 2 } = {}) {
  globalThis.sampleRate = fixture.rate;
  const processor = new Processor();
  processor.port.onmessage({ data: { type: "settings", sensitivity: 7, mode } });
  const silence = new Float32Array(fixture.audio.length);
  const negative = stereo === "opposite" ? fixture.audio.map((value) => -value) : null;
  for (let start = 0, block = 0; start < fixture.audio.length; block += 1) {
    const end = Math.min(fixture.audio.length, start + chunks[block % chunks.length]);
    const audio = fixture.audio.subarray(start, end);
    const channels = stereo === "right" ? [silence.subarray(start, end), audio]
      : stereo === "opposite" ? [audio, negative.subarray(start, end)] : [audio];
    globalThis.currentFrame = start;
    processor.process([channels]);
    start = end;
  }
  const frames = processor.messages.flatMap((message) => message.frames);
  const tracker = new PulseTracker();
  const estimates = [];
  for (const frame of frames) {
    const estimate = tracker.push(frame, processor.hop * 1000 / fixture.rate, division);
    if (estimate) estimates.push({ timeMs: frame.timeMs, ...estimate });
  }
  return { onsets: frames.filter((frame) => frame.onset).map((frame) => frame.timeMs),
    frames, estimates, lastEstimate: tracker.estimate };
}

function assertAttacks(result, times, toleranceMs = 22) {
  assert.equal(result.onsets.length, times.length,
    `expected ${times.length} attacks, got ${result.onsets.length}: ${result.onsets.map(Math.round)}`);
  times.forEach((time, i) => assert.ok(Math.abs(result.onsets[i] - time) < toleranceMs,
    `attack ${i}: expected ${time}, got ${result.onsets[i]}`));
}

test("PCM picking measures all subdivisions across slow and fast tempos", () => {
  for (const rate of [44100, 48000]) {
    for (const [bpm, division] of [[30, 1], [60, 2], [100, 3], [160, 4], [240, 4]]) {
      const fixture = guitar({ rate, bpm, division, decay: 0.07 });
      const result = analyse(fixture, { division });
      assertAttacks(result, fixture.times);
      assert.ok(result.lastEstimate, `${bpm} BPM, ${division} subdivision, ${rate} Hz: no BPM`);
      assert.ok(Math.abs(result.lastEstimate.bpm - bpm) / bpm < 0.03,
        `${bpm} BPM, ${division} subdivision, ${rate} Hz: ${result.lastEstimate.bpm}`);
    }
  }
});

test("quiet low E and palm-muted notes survive without high interface gain", () => {
  for (const muted of [false, true]) {
    const fixture = guitar({ amplitude: 0.004, decay: 0.035, muted });
    const result = analyse(fixture);
    assertAttacks(result, fixture.times);
    assert.ok(Math.abs(result.lastEstimate.bpm - 100) < 2);
  }
});

test("a quieter intentional note after an accent is still an attack", () => {
  const fixture = guitar({ dynamics: true, decay: 0.05 });
  assertAttacks(analyse(fixture), fixture.times);
});

test("rhythm mode counts a six-string strum once, including fast strumming", () => {
  for (const [bpm, division] of [[100, 2], [180, 4]]) {
    const fixture = guitar({ bpm, division, chord: true, decay: 0.05 });
    const result = analyse(fixture, { mode: "rhythm", division });
    assertAttacks(result, fixture.times);
    assert.ok(Math.abs(result.lastEstimate.bpm - bpm) < 3);
  }
});

test("right-only and opposite-polarity stereo inputs retain every guitar attack", () => {
  const fixture = guitar();
  for (const stereo of ["right", "opposite"]) {
    const result = analyse(fixture, { stereo });
    assertAttacks(result, fixture.times);
    assert.ok(Math.abs(result.lastEstimate.bpm - 100) < 2);
  }
});

test("irregular render block sizes do not change capture timestamps or BPM", () => {
  const fixture = guitar({ duration: 6 });
  const normal = analyse(fixture);
  const irregular = analyse(fixture, { chunks: [64, 256, 128, 512, 73] });
  assert.deepEqual(irregular.onsets, normal.onsets);
  assert.deepEqual(irregular.lastEstimate, normal.lastEstimate);
});

test("stopping clears BPM and a new performance reacquires it", () => {
  const fixture = guitar({ stopAt: 4, duration: 8, decay: 0.06 });
  const result = analyse(fixture);
  assert.ok(result.estimates.length > 0);
  assert.equal(result.lastEstimate, null);
  const tracker = new PulseTracker();
  for (const frame of result.frames) tracker.push(frame, 5, 2);
  tracker.reset();
  assert.equal(tracker.estimate, null);
  assert.deepEqual(tracker.readings, []);
});

test("silence, mains hum, and one sustained note never produce a tempo", () => {
  for (const options of [
    { amplitude: 0 }, { amplitude: 0, hum: 0.01 }, { amplitude: 0, hiss: 0.002 },
    { sustain: true, decay: 1.5 }, { sustain: true, decay: 1.5, vibrato: true },
  ]) {
    const result = analyse(guitar(options));
    assert.equal(result.lastEstimate, null, JSON.stringify({ options, onsets: result.onsets }));
    assert.equal(result.estimates.length, 0, JSON.stringify({ options, onsets: result.onsets, estimates: result.estimates }));
    if (options.sustain) assert.equal(result.onsets.length, 1);
  }
});

test("timing jitter and rests preserve the played attack times and underlying pulse", () => {
  const fixture = guitar({ decay: 0.06, irregular: true, skipped: new Set([3, 7, 8, 14, 19]) });
  const result = analyse(fixture);
  assertAttacks(result, fixture.times);
  assert.ok(Math.abs(result.lastEstimate.bpm - 100) < 3);
});

test("channel changes preserve every uniformly sampled frame", () => {
  const fixture = guitar({ duration: 4 });
  const result = analyse(fixture, { stereo: "right" });
  for (let i = 1; i < result.frames.length; i += 1) {
    assert.ok(Math.abs(result.frames[i].timeMs - result.frames[i - 1].timeMs - 5) < 1e-6);
  }
});
