import { describe, expect, it } from "vitest";
import { estimateTempo } from "../features/timing/analysis";
import { synthGuitar, type SynthOptions } from "../test/synth-guitar";
import { OnsetDetector, type DetectorSettings } from "./onset-detector";

function detect(
  options: SynthOptions,
  settings: Partial<DetectorSettings> = {},
  { blocks = [128], stereo = "mono" }: { blocks?: number[]; stereo?: "mono" | "right" | "inverted" } = {},
) {
  const fixture = synthGuitar(options);
  const detector = new OnsetDetector(fixture.sampleRate, settings);
  const onsets: number[] = [];
  detector.onOnset = (onset) => onsets.push(onset.timeMs);
  const silence = new Float32Array(fixture.audio.length);
  const inverted = fixture.audio.map((value) => -value);
  for (let start = 0, block = 0; start < fixture.audio.length; block += 1) {
    const end = Math.min(fixture.audio.length, start + blocks[block % blocks.length]);
    const mono = fixture.audio.subarray(start, end);
    const channels =
      stereo === "right"
        ? [silence.subarray(start, end), mono]
        : stereo === "inverted"
          ? [mono, inverted.subarray(start, end)]
          : [mono];
    detector.process(channels, start);
    start = end;
  }
  return { onsets, truth: fixture.attacksMs };
}

function expectAttacks({ onsets, truth }: { onsets: number[]; truth: number[] }, toleranceMs = 3) {
  expect(onsets.length, `found ${onsets.map(Math.round).join(", ")}`).toBe(truth.length);
  onsets.forEach((time, i) => expect(Math.abs(time - truth[i]), `attack ${i}`).toBeLessThan(toleranceMs));
}

describe("OnsetDetector", () => {
  it("times picked notes to within 3 ms at common sample rates", () => {
    for (const sampleRate of [44100, 48000, 96000]) expectAttacks(detect({ sampleRate }));
  });

  it("keeps up with fast sixteenths and slow quarter notes", () => {
    expectAttacks(detect({ bpm: 240, subdivision: 4, decayS: 0.07 }));
    expectAttacks(detect({ bpm: 40, subdivision: 1, decayS: 0.5 }));
  });

  it("detects new notes over ringing strings", () => {
    expectAttacks(detect({ decayS: 1.2 }));
    expectAttacks(detect({ decayS: 1.2, notes: [110, 146.8, 196, 164.8] }));
  });

  it("hears quiet, palm-muted and accented playing", () => {
    expectAttacks(detect({ amplitude: 0.001 }));
    expectAttacks(detect({ amplitude: 0.0005 }, { sensitivity: 10 }));
    expectAttacks(detect({ amplitude: 0.004, palmMuted: true }));
    expectAttacks(detect({ accentRatio: 0.15 }));
  });

  it("counts each strum once, including fast alternate strumming", () => {
    expectAttacks(detect({ chord: true, alternateStrums: true }, { style: "strum" }));
    expectAttacks(detect({ chord: true, alternateStrums: true, strumSpreadMs: 10, decayS: 0.6 }, { style: "strum" }));
    expectAttacks(
      detect({ chord: true, alternateStrums: true, bpm: 180, subdivision: 4, decayS: 0.08 }, { style: "strum" }),
    );
  });

  it("handles distortion with a small constant offset", () => {
    const { onsets, truth } = detect({ drive: 3, decayS: 0.6 });
    expect(onsets.length).toBe(truth.length);
    const errors = onsets.map((time, i) => time - truth[i]);
    expect(Math.max(...errors) - Math.min(...errors)).toBeLessThan(2);
  });

  it("finds the guitar on either stereo channel, even with inverted polarity", () => {
    expectAttacks(detect({}, {}, { stereo: "right" }));
    expectAttacks(detect({}, {}, { stereo: "inverted" }));
  });

  it("gives identical results for any audio block size", () => {
    const regular = detect({ durationS: 4 });
    const irregular = detect({ durationS: 4 }, {}, { blocks: [64, 256, 128, 512, 73] });
    expect(irregular.onsets).toEqual(regular.onsets);
  });

  it("stays silent for silence, hum, hiss and sustained notes", () => {
    for (const sensitivity of [7, 10]) {
      expect(detect({ amplitude: 0 }, { sensitivity }).onsets).toHaveLength(0);
      expect(detect({ amplitude: 0, humAmplitude: 0.01, hissAmplitude: 0.002 }, { sensitivity }).onsets).toHaveLength(0);
      expect(detect({ amplitude: 0, hissAmplitude: 0.01 }, { sensitivity }).onsets).toHaveLength(0);
    }
    expectAttacks(detect({ sustain: true, decayS: 2, vibrato: true }));
  });
});

describe("guitar audio to tempo", () => {
  it("measures the played tempo from real PCM", () => {
    const cases = [
      { bpm: 100, subdivision: 2, style: "pick" as const, chord: false },
      { bpm: 72, subdivision: 1, style: "strum" as const, chord: true },
      { bpm: 160, subdivision: 4, style: "pick" as const, chord: false },
      { bpm: 90, subdivision: 3, style: "pick" as const, chord: false },
      { bpm: 120, subdivision: 4, style: "strum" as const, chord: true },
    ];
    for (const { bpm, subdivision, style, chord } of cases) {
      const { onsets } = detect(
        { bpm, subdivision, chord, alternateStrums: chord, decayS: 0.08, jitterMs: [0, 9, -6, 4, -11] },
        { style },
      );
      const tempo = estimateTempo(onsets, 60000 / bpm, "auto");
      expect(tempo, `${bpm} BPM`).not.toBeNull();
      expect(tempo!.subdivision).toBe(subdivision);
      expect(Math.abs(tempo!.bpm - bpm) / bpm).toBeLessThan(0.01);
    }
  });
});
