import { describe, expect, it } from "vitest";
import { cleanStreak, formatCount, parseCount, resizeRiff, riffShift, riffTempo, scoreRiff, statsByNote, stepName, tapTempo } from "./riff";

describe("riffTempo", () => {
  it("reads the tempo played from uneven riff notes", () => {
    const steps = (parseCount("1 & 2 & 3 e & a 4 e & a", 4) as { steps: boolean[] }).steps;
    const notes = steps.flatMap((on, i) => (on ? [i] : []));
    // Played at 99 BPM against a 100 BPM click for two bars, notes ±25 ms off.
    const stepMs = 60000 / 99 / 4;
    const onsets = Array.from({ length: 2 }, (_, bar) => notes.map((s, i) => 1000 + (bar * 16 + s) * stepMs + (i % 2 ? 25 : -25))).flat();
    const bars = scoreRiff(onsets, { originMs: 1000, beatMs: 600 }, steps, onsets.at(-1)! + 2000);
    const tempo = riffTempo(bars, 16)!;
    expect(tempo.bpm).toBeCloseTo(99, 0);
    expect(tempo.spreadMs).toBeGreaterThan(20);
  });
});

const KILL_THE_KING = "1 & 2 & 3 e & a 4 e & a";

describe("parseCount", () => {
  it("reads a spoken count, with or without spaces", () => {
    const parsed = parseCount(KILL_THE_KING, 4);
    expect("steps" in parsed && parsed.steps.flatMap((on, i) => (on ? [i] : []))).toEqual([0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(parseCount("1&2&3e&a4e&a", 4)).toEqual(parsed);
    expect(parseCount("1 and 2 + 3 e and a, 4 e & a", 4)).toEqual(parsed);
  });

  it("round-trips through formatCount", () => {
    const parsed = parseCount("1 e 2 a 4 &", 4);
    expect("steps" in parsed && formatCount(parsed.steps)).toBe("1 e 2 a 4 &");
  });

  it("explains counts it cannot read", () => {
    expect(parseCount("1 & 5", 4)).toEqual({ error: "There is no beat 5 in a bar of 4." });
    expect(parseCount("& 2", 4)).toMatchObject({ error: expect.stringContaining("Start with a beat number") });
    expect(parseCount("1 & e", 4)).toMatchObject({ error: expect.stringContaining("the order is 1 e & a") });
    expect(parseCount("2 1", 4)).toMatchObject({ error: expect.stringContaining("in order") });
    expect(parseCount("1 x", 4)).toMatchObject({ error: expect.stringContaining('"x"') });
    expect(parseCount("", 4)).toMatchObject({ error: expect.stringContaining("at least one note") });
  });

  it("names steps and keeps beats when the bar length changes", () => {
    expect(stepName(9)).toBe("3 e");
    expect(stepName(12)).toBe("4");
    const parsed = parseCount(KILL_THE_KING, 4) as { steps: boolean[] };
    expect(formatCount(resizeRiff(parsed.steps, 3))).toBe("1 & 2 & 3 e & a");
  });
});

describe("scoreRiff", () => {
  const bpm = 140;
  const beatMs = 60000 / bpm;
  const stepMs = beatMs / 4;
  const grid = { originMs: 1000, beatMs };
  const steps = (parseCount(KILL_THE_KING, 4) as { steps: boolean[] }).steps;
  const notes = steps.flatMap((on, i) => (on ? [i] : []));
  /** The riff played for `bars` bars, with an error (ms) per note from `shift`. */
  const play = (bars: number, shift: (bar: number, step: number) => number | null = () => 0) =>
    Array.from({ length: bars }, (_, bar) =>
      notes.flatMap((step) => {
        const error = shift(bar, step);
        return error === null ? [] : [grid.originMs + (bar * 16 + step) * stepMs + error];
      }),
    ).flat();
  const end = (bars: number) => grid.originMs + bars * 16 * stepMs + 200;

  it("marks bars played exactly as clean", () => {
    const bars = scoreRiff(play(3), grid, steps, end(3));
    expect(bars.filter((b) => b.complete).map((b) => b.clean)).toEqual([true, true, true]);
    expect(bars[0].hit).toBe(12);
    expect(cleanStreak(bars)).toBe(3);
  });

  it("finds missed notes, extra notes and early or late ones", () => {
    const onsets = play(2, (bar, step) => (bar === 1 && step === 9 ? null : bar === 1 && step === 13 ? -30 : 0));
    onsets.push(grid.originMs + 1 * stepMs); // a note on "1 e", which is a rest
    onsets.sort((a, b) => a - b);
    const [first, second] = scoreRiff(onsets, grid, steps, end(2));
    expect(first.extras).toHaveLength(1);
    expect(first.extras[0]).toBeCloseTo(1);
    expect(first.clean).toBe(false);
    expect(second.missed).toBe(1);
    expect(second.notes.find((n) => n.step === 9)?.errorMs).toBeNull();
    expect(second.notes.find((n) => n.step === 13)?.errorMs).toBeCloseTo(-30);
    expect(cleanStreak([first, second])).toBe(0);
  });

  it("counts a late eighth as late, not as the next sixteenth", () => {
    // "1 &" played 50 ms late is still "1 &": "1 a" is a rest in this riff.
    const bars = scoreRiff(play(1, (_, step) => (step === 2 ? 50 : 0)), grid, steps, end(1));
    expect(bars[0].notes.find((n) => n.step === 2)?.errorMs).toBeCloseTo(50);
    expect(bars[0].extras).toEqual([]);
    expect(bars[0].clean).toBe(false); // 50 ms is beyond the clean limit
  });

  it("shows a very late eighth as very late, not as missed plus an extra", () => {
    // At 140 BPM "1 &" 100 ms late sits past "1 a" (a rest) but is still nearer "1 &" than "2".
    const bars = scoreRiff(play(1, (_, step) => (step === 2 ? 100 : 0)), grid, steps, end(1));
    expect(bars[0].notes.find((n) => n.step === 2)?.errorMs).toBeCloseTo(100);
    expect(bars[0].missed).toBe(0);
    expect(bars[0].extras).toEqual([]);
  });

  it("leaves notes of the bar in progress pending, not missed", () => {
    const onsets = play(2).filter((t) => t < grid.originMs + 16 * stepMs + 5 * stepMs);
    const bars = scoreRiff(onsets, grid, steps, grid.originMs + 16 * stepMs + 5.5 * stepMs);
    expect(bars[1].complete).toBe(false);
    expect(bars[1].missed).toBe(0);
    expect(bars[1].notes.at(-1)?.errorMs).toBeUndefined();
  });

  it("averages each note's timing over complete bars", () => {
    const stats = statsByNote(scoreRiff(play(4, (_, step) => (step === 11 ? -20 : 0)), grid, steps, end(4)));
    const a = stats.find((s) => s.step === 11)!;
    expect(a.hit).toBe(4);
    expect(a.meanMs).toBeCloseTo(-20);
  });

  it("breaks the streak when the player stops for a bar", () => {
    const onsets = [...play(2), ...play(4).filter((t) => t > grid.originMs + 3 * 16 * stepMs - 10)];
    const bars = scoreRiff(onsets, grid, steps, end(4));
    expect(bars.map((b) => b.empty)).toEqual([false, false, true, false]);
    expect(cleanStreak(bars)).toBe(1);
  });
});

describe("riffShift", () => {
  const beatMs = 60000 / 140;
  const stepMs = beatMs / 4;
  const grid = { originMs: 1000, beatMs };
  const steps = (parseCount(KILL_THE_KING, 4) as { steps: boolean[] }).steps;
  const notes = steps.flatMap((on, i) => (on ? [i] : []));
  const played = (startStep: number) =>
    Array.from({ length: 4 }, (_, bar) => notes.map((step) => grid.originMs + (bar * 16 + step + startStep) * stepMs + 4)).flat();
  const now = grid.originMs + 6 * 16 * stepMs;

  it("spots a riff started on the wrong step", () => {
    expect(riffShift(played(6), grid, steps, now)).toBe(6); // started on "2 &"
  });

  it("stays quiet when the riff is played in place", () => {
    expect(riffShift(played(0), grid, steps, now)).toBe(0);
  });
});

describe("tapTempo", () => {
  it("averages recent taps and starts over after a pause", () => {
    expect(tapTempo([0])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 500, 5000, 5429, 5857])).toBeCloseTo(140, 0);
  });
});
