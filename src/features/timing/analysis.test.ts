import { describe, expect, it } from "vitest";
import {
  countName,
  currentPhrase,
  dropGhosts,
  ghostWindowMs,
  estimateTempo,
  gradeHit,
  gridErrorMs,
  pulseFit,
  statsByCount,
  summarizeHits,
  type SubdivisionSetting,
} from "./analysis";

function random(seed = 1) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

/** Attack times for a rhythm (gaps in beats) repeated over `beats` beats. */
function play({
  bpm,
  pattern,
  beats = 16,
  jitterMs = 0,
  seed = 3,
  startMs = 1000,
}: {
  bpm: number;
  pattern: number[];
  beats?: number;
  jitterMs?: number;
  seed?: number;
  startMs?: number;
}) {
  const next = random(seed);
  const beatMs = 60000 / bpm;
  const onsets: number[] = [];
  for (let position = 0, step = 0; position < beats - 1e-9; step += 1) {
    onsets.push(startMs + position * beatMs + (next() * 2 - 1) * jitterMs);
    position += pattern[step % pattern.length];
  }
  return onsets;
}

const reading = (onsets: number[], clickBpm: number, setting: SubdivisionSetting = "auto") =>
  estimateTempo(onsets, 60000 / clickBpm, setting);

describe("estimateTempo", () => {
  it("reads steady playing at the click tempo for every subdivision", () => {
    const cases = [
      { pattern: [1, 1, 1, 1], subdivision: 1 },
      { pattern: [0.5], subdivision: 2 },
      { pattern: [1 / 3], subdivision: 3 },
      { pattern: [0.25], subdivision: 4 },
    ];
    for (const bpm of [40, 60, 100, 140, 200]) {
      for (const { pattern, subdivision } of cases) {
        const result = reading(play({ bpm, pattern, beats: subdivision === 1 ? 8 : 6 }), bpm);
        expect(result, `${bpm} BPM, ${subdivision}/beat`).not.toBeNull();
        expect(result!.subdivision).toBe(subdivision);
        expect(result!.bpm).toBeCloseTo(bpm, 1);
        expect(result!.followsClick).toBe(true);
      }
    }
  });

  it("does not halve or double the tempo when strumming quarter notes", () => {
    // The old detector required choosing "1/8" or "1/4" up front and divided by it.
    const result = reading(play({ bpm: 90, pattern: [1], beats: 8 }), 90);
    expect(result!.bpm).toBeCloseTo(90, 1);
    expect(result!.subdivision).toBe(1);
  });

  it("handles strumming patterns with rests and mixed note lengths", () => {
    // D - D U - U D U (eighths with rests)
    const strum = reading(play({ bpm: 96, pattern: [1, 0.5, 1, 0.5, 0.5, 0.5] }), 96);
    expect(strum!.subdivision).toBe(2);
    expect(strum!.bpm).toBeCloseTo(96, 1);
    // Gallop: eighth + two sixteenths
    const gallop = reading(play({ bpm: 150, pattern: [0.5, 0.25, 0.25] }), 150);
    expect(gallop!.subdivision).toBe(4);
    expect(gallop!.bpm).toBeCloseTo(150, 1);
    // Swung eighths sit on the triplet grid
    const swing = reading(play({ bpm: 120, pattern: [2 / 3, 1 / 3] }), 120);
    expect(swing!.subdivision).toBe(3);
    expect(swing!.bpm).toBeCloseTo(120, 1);
  });

  it("stays accurate with human timing jitter", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = reading(play({ bpm: 110, pattern: [0.5], beats: 8, jitterMs: 25, seed }), 110);
      expect(result!.subdivision).toBe(2);
      expect(Math.abs(result!.bpm - 110)).toBeLessThan(1.5);
    }
  });

  it("reports rushing and dragging instead of snapping to the click", () => {
    const rushing = reading(play({ bpm: 106, pattern: [0.5], beats: 8 }), 100);
    expect(rushing!.bpm).toBeCloseTo(106, 1);
    const dragging = reading(play({ bpm: 93, pattern: [0.25], beats: 4 }), 100);
    expect(dragging!.bpm).toBeCloseTo(93, 1);
    expect(dragging!.subdivision).toBe(4);
  });

  it("ignores stray attacks between notes", () => {
    const onsets = play({ bpm: 100, pattern: [0.5], beats: 10 });
    const withStrays = [...onsets, onsets[3] + 110, onsets[9] + 70, onsets[14] + 190].sort((a, b) => a - b);
    const result = reading(withStrays, 100);
    expect(result!.subdivision).toBe(2);
    expect(result!.bpm).toBeCloseTo(100, 1);
  });

  it("measures playing far from the click without comparing it to the click", () => {
    const result = reading(play({ bpm: 140, pattern: [0.5], beats: 8 }), 100, 2);
    expect(result!.followsClick).toBe(false);
    expect(result!.bpm).toBeCloseTo(140, 1);
  });

  it("respects a manually chosen subdivision", () => {
    // Quarter notes read as eighths with rests: still the same tempo.
    const result = reading(play({ bpm: 80, pattern: [1], beats: 8 }), 80, 2);
    expect(result!.subdivision).toBe(2);
    expect(result!.bpm).toBeCloseTo(80, 1);
  });

  it("waits for enough attacks", () => {
    expect(reading([1000, 1300, 1600, 1900], 100)).toBeNull();
  });

  it("returns nothing for random noise hits", () => {
    const next = random(9);
    const onsets: number[] = [];
    for (let time = 0; onsets.length < 20; time += 80 + next() * 700) onsets.push(time);
    expect(reading(onsets, 100)).toBeNull();
  });
});

describe("timing helpers", () => {
  it("signs grid errors: early is negative, late is positive", () => {
    expect(gridErrorMs(1590, 1000, 300)).toBeCloseTo(-10);
    expect(gridErrorMs(1615, 1000, 300)).toBeCloseTo(15);
    expect(gridErrorMs(1000, 1000, 300)).toBeCloseTo(0);
  });

  it("grades hits", () => {
    expect(gradeHit(-12)).toBe("tight");
    expect(gradeHit(30)).toBe("close");
    expect(gradeHit(-80)).toBe("off");
  });

  it("fits whole-number gaps to a pulse", () => {
    expect(pulseFit([300, 600, 300, 900], 300)).toBeCloseTo(1);
    expect(pulseFit([150, 150, 150], 300)).toBeLessThan(0.1);
  });

  it("splits phrases at long silences", () => {
    expect(currentPhrase([0, 500, 1000, 5000, 5500, 6000], 600)).toEqual([5000, 5500, 6000]);
  });

  it("names counts", () => {
    expect(countName(0, 4, 4)).toBe("1");
    expect(countName(5, 4, 4)).toBe("2 e");
    expect(countName(15, 4, 4)).toBe("4 a");
    expect(countName(16, 4, 4)).toBe("1");
    expect(countName(3, 2, 4)).toBe("2 &");
    expect(countName(4, 3, 4)).toBe("2 trip");
  });

  it("groups timing by count within the beat", () => {
    const hits = [0, 1, 2, 3, 4, 5, 6, 7].map((slot) => ({ slot, errorMs: slot % 4 === 3 ? -18 : 2 }));
    const stats = statsByCount(hits, 4);
    expect(stats.map((stat) => stat.syllable)).toEqual(["", "e", "&", "a"]);
    expect(stats[3].meanMs).toBe(-18);
    expect(stats[3].count).toBe(2);
    expect(stats[0].meanMs).toBe(2);
  });

  it("summarizes hits", () => {
    const summary = summarizeHits([-10, 10, 30, -30]);
    expect(summary!.meanMs).toBe(0);
    expect(summary!.tightPercent).toBe(50);
    expect(summary!.spreadMs).toBeCloseTo(Math.sqrt(500));
  });
});

describe("dropGhosts", () => {
  it("keeps the real attack when pick noise comes just before it", () => {
    // From a real palm-muted recording at 100 BPM: weak ghosts 40-70 ms before notes.
    const onsets = [
      { timeMs: 12950, strength: 0.38 },
      { timeMs: 12990, strength: 1.0 },
      { timeMs: 13250, strength: 0.44 },
      { timeMs: 13320, strength: 0.88 },
      { timeMs: 13410, strength: 0.38 },
      { timeMs: 13480, strength: 0.87 },
      { timeMs: 13610, strength: 0.41 },
    ];
    const window = ghostWindowMs(600);
    expect(window).toBe(90);
    expect(dropGhosts(onsets, window).map((o) => o.timeMs)).toEqual([12990, 13320, 13480, 13610]);
  });

  it("leaves real sixteenths alone", () => {
    const beatMs = 60000 / 140;
    const sixteenths = Array.from({ length: 16 }, (_, i) => ({ timeMs: i * (beatMs / 4) + (i % 2 ? 12 : -8), strength: 1 }));
    expect(dropGhosts(sixteenths, ghostWindowMs(beatMs))).toHaveLength(16);
  });
});
