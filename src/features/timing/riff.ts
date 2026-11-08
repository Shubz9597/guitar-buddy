// A riff rhythm is the set of sixteenth-note steps in one bar that the player
// actually picks ("1 & 2 & 3 e & a 4 e & a"). Knowing it, each bar can be
// checked note by note: which notes landed and how far off, which were
// missed, and which extra notes were played on a rest.

import { LOOSE_MS } from "./analysis";

export const STEPS_PER_BEAT = 4;
const SYLLABLES = ["", "e", "&", "a"] as const;

export const emptyRiff = (beatsPerBar: number) => Array.from({ length: beatsPerBar * STEPS_PER_BEAT }, () => false);

/** Keeps the steps of the beats that still exist when the bar length changes. */
export function resizeRiff(steps: readonly boolean[], beatsPerBar: number): boolean[] {
  return Array.from({ length: beatsPerBar * STEPS_PER_BEAT }, (_, i) => steps[i] === true);
}

/** "3 e" for step 9. */
export function stepName(step: number): string {
  const beat = Math.floor(step / STEPS_PER_BEAT) + 1;
  const syllable = SYLLABLES[step % STEPS_PER_BEAT];
  return syllable ? `${beat} ${syllable}` : String(beat);
}

/** The count the player would say: "1 & 2 & 3 e & a 4 e & a". */
export function formatCount(steps: readonly boolean[]): string {
  const words: string[] = [];
  steps.forEach((on, step) => {
    if (!on) return;
    const syllable = SYLLABLES[step % STEPS_PER_BEAT];
    words.push(syllable || String(Math.floor(step / STEPS_PER_BEAT) + 1));
  });
  return words.join(" ");
}

/**
 * Reads a count like "1 & 2 & 3 e & a 4 e & a" (spaces optional, "and" or
 * "+" for "&"). Every number is a beat that is played; e, &, a are the
 * sixteenths after the last number.
 */
export function parseCount(text: string, beatsPerBar: number): { steps: boolean[] } | { error: string } {
  const steps = emptyRiff(beatsPerBar);
  const tokens = text.toLowerCase().match(/\d+|and|[&+ea]|[^\s,|.\-–]/g) ?? [];
  let beat = -1;
  let last = -1;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1 || n > beatsPerBar) return { error: `There is no beat ${n} in a bar of ${beatsPerBar}.` };
      if (n - 1 <= beat) return { error: `Beat ${n} comes after beat ${beat + 1}: write the count in order.` };
      beat = n - 1;
      last = beat * STEPS_PER_BEAT;
      steps[last] = true;
      continue;
    }
    const index = token === "and" || token === "+" ? 2 : SYLLABLES.indexOf(token as (typeof SYLLABLES)[number]);
    if (index <= 0) return { error: `"${token}" isn't part of a count. Use beat numbers with e, & and a.` };
    if (beat < 0) return { error: `Start with a beat number, e.g. "1 ${token}" instead of "${token}".` };
    const step = beat * STEPS_PER_BEAT + index;
    if (step <= last) return { error: `"${SYLLABLES[index]}" comes too early in beat ${beat + 1}: the order is ${beat + 1} e & a.` };
    steps[step] = true;
    last = step;
  }
  if (!steps.includes(true)) return { error: "Type at least one note, e.g. 1 & 2 &." };
  return { steps };
}

export interface RiffNote {
  step: number;
  /** Audio-clock time the note was played (null when missed or not due yet). */
  timeMs: number | null;
  /** Signed error: negative early, positive late. null = missed, undefined = not due yet. */
  errorMs: number | null | undefined;
}

export interface BarResult {
  /** Bar number counted from the click's start (or its last tempo change). */
  bar: number;
  notes: RiffNote[];
  /** Notes played where the riff has a rest, as a step position (may be fractional). */
  extras: number[];
  complete: boolean;
  /** No note at all: the player stopped. */
  empty: boolean;
  hit: number;
  missed: number;
  meanMs: number | null;
  /** Complete, nothing missed or extra, and every note within LOOSE_MS. */
  clean: boolean;
}

/**
 * Lines played notes up with the riff, bar by bar. Each note is matched to
 * the nearest expected note; a note too far from any expected note (or a
 * second note on one already matched) counts as extra.
 */
export function scoreRiff(
  onsetsMs: readonly number[],
  grid: { originMs: number; beatMs: number },
  steps: readonly boolean[],
  nowMs: number,
): BarResult[] {
  const positions = steps.flatMap((on, i) => (on ? [i] : []));
  if (positions.length === 0) return [];
  const perBar = steps.length;
  const stepMs = grid.beatMs / STEPS_PER_BEAT;
  const barMs = stepMs * perBar;
  // Beyond this a note is not an early or late version of the expected one.
  // Each note goes to the nearest expected note anyway, so between notes an
  // eighth apart a note 130 ms late is still that note (shown as very late),
  // not "missed" plus an extra; only notes deep inside a long rest are extra.
  const window = Math.max(LOOSE_MS * 2, stepMs * 0.75, grid.beatMs / 2);
  const expected = (bar: number, step: number) => grid.originMs + (bar * perBar + step) * stepMs;

  const matched = new Map<number, { timeMs: number; errorMs: number }>();
  const extras = new Map<number, number[]>();
  const addExtra = (timeMs: number) => {
    const position = (timeMs - grid.originMs) / stepMs;
    const bar = Math.floor(position / perBar);
    extras.set(bar, [...(extras.get(bar) ?? []), position - bar * perBar]);
  };

  for (const timeMs of onsetsMs) {
    if (timeMs < grid.originMs - window) continue;
    const around = Math.floor((timeMs - grid.originMs) / barMs);
    let best: { key: number; errorMs: number } | null = null;
    for (let bar = around - 1; bar <= around + 1; bar++) {
      if (bar < 0) continue;
      for (const step of positions) {
        const errorMs = timeMs - expected(bar, step);
        if (!best || Math.abs(errorMs) < Math.abs(best.errorMs)) best = { key: bar * perBar + step, errorMs };
      }
    }
    if (!best || Math.abs(best.errorMs) > window) {
      addExtra(timeMs);
      continue;
    }
    const previous = matched.get(best.key);
    if (previous && Math.abs(previous.errorMs) <= Math.abs(best.errorMs)) {
      addExtra(timeMs);
      continue;
    }
    if (previous) addExtra(previous.timeMs);
    matched.set(best.key, { timeMs, errorMs: best.errorMs });
  }

  const bars = [...matched.keys()].map((key) => Math.floor(key / perBar));
  if (bars.length === 0) return [];
  const first = Math.min(...bars);
  const current = Math.floor((nowMs - grid.originMs) / barMs);
  const last = Math.max(current, ...bars);

  // A note can still arrive until halfway to the next riff note (or the
  // window); after that a later note belongs to the next one.
  const dueBy = (bar: number, i: number) => {
    const next = i + 1 < positions.length ? positions[i + 1] : positions[0] + perBar;
    return expected(bar, positions[i]) + Math.min(window, ((next - positions[i]) * stepMs) / 2);
  };
  const results: BarResult[] = [];
  for (let bar = first; bar <= last; bar++) {
    const complete = dueBy(bar, positions.length - 1) < nowMs;
    const notes: RiffNote[] = positions.map((step, i) => {
      const hit = matched.get(bar * perBar + step);
      if (hit) return { step, timeMs: hit.timeMs, errorMs: hit.errorMs };
      return { step, timeMs: null, errorMs: dueBy(bar, i) < nowMs ? null : undefined };
    });
    const errors = notes.flatMap((n) => (typeof n.errorMs === "number" ? [n.errorMs] : []));
    const barExtras = extras.get(bar) ?? [];
    const missed = notes.filter((n) => n.errorMs === null).length;
    const empty = errors.length === 0 && barExtras.length === 0;
    if (empty && !complete) continue; // not reached yet
    results.push({
      bar,
      notes,
      extras: barExtras,
      complete,
      empty,
      hit: errors.length,
      missed,
      meanMs: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
      clean: complete && !empty && missed === 0 && barExtras.length === 0 && errors.every((e) => Math.abs(e) <= LOOSE_MS),
    });
  }
  return results;
}

const fitScore = (bars: readonly BarResult[]) =>
  bars.reduce(
    (score, bar) =>
      score + bar.notes.filter((n) => typeof n.errorMs === "number" && Math.abs(n.errorMs) <= LOOSE_MS).length - bar.extras.length,
    0,
  );

/**
 * When the riff is played starting on the wrong step (on "2 &" instead of
 * "1"), every bar looks wrong. Returns the step the player seems to start the
 * riff on, if another starting point explains the notes much better; else 0.
 */
export function riffShift(
  onsetsMs: readonly number[],
  grid: { originMs: number; beatMs: number },
  steps: readonly boolean[],
  nowMs: number,
): number {
  const stepMs = grid.beatMs / STEPS_PER_BEAT;
  const fit = (shift: number) => fitScore(scoreRiff(onsetsMs, { ...grid, originMs: grid.originMs + shift * stepMs }, steps, nowMs));
  const base = fit(0);
  let best = { shift: 0, score: base };
  for (let shift = 1; shift < steps.length; shift++) {
    const score = fit(shift);
    if (score > best.score) best = { shift, score };
  }
  const notesPerBar = steps.filter(Boolean).length;
  return best.shift !== 0 && best.score >= base * 1.3 + notesPerBar ? best.shift : 0;
}

/** Clean bars in a row at the end of the played bars; a bar with a slip or a pause resets it. */
export function cleanStreak(bars: readonly BarResult[]): number {
  let streak = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (!bars[i].complete) continue;
    if (!bars[i].clean) break;
    streak++;
  }
  return streak;
}

export interface NoteStats {
  step: number;
  /** Times played out of times due. */
  hit: number;
  due: number;
  meanMs: number | null;
}

/** Per riff note, across complete bars: how often it lands and where. */
export function statsByNote(bars: readonly BarResult[]): NoteStats[] {
  const played = bars.filter((b) => b.complete && !b.empty);
  if (played.length === 0) return [];
  return played[0].notes.map((_, i) => {
    const errors = played.flatMap((b) => (typeof b.notes[i].errorMs === "number" ? [b.notes[i].errorMs as number] : []));
    return {
      step: played[0].notes[i].step,
      hit: errors.length,
      due: played.length,
      meanMs: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    };
  });
}

/**
 * The tempo actually played, from the riff notes of the last few bars: a
 * straight-line fit of each note's time against its place in the riff. Works
 * even when the playing is too uneven for the free tempo estimate.
 */
export function riffTempo(bars: readonly BarResult[], perBar: number, lastBars = 4): { bpm: number; spreadMs: number; notes: number } | null {
  const points = bars
    .filter((b) => !b.empty)
    .slice(-lastBars)
    .flatMap((b) => b.notes.flatMap((n) => (n.timeMs !== null && typeof n.errorMs === "number" ? [{ x: b.bar * perBar + n.step, y: n.timeMs }] : [])));
  if (points.length < 8) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  let cov = 0;
  let varX = 0;
  for (const p of points) {
    cov += (p.x - mx) * (p.y - my);
    varX += (p.x - mx) ** 2;
  }
  if (varX === 0) return null;
  const stepMs = cov / varX;
  if (!(stepMs > 0)) return null;
  const residuals = points.map((p) => p.y - (my + (p.x - mx) * stepMs));
  const spreadMs = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, points.length - 2));
  return { bpm: 60000 / (stepMs * STEPS_PER_BEAT), spreadMs, notes: points.length };
}

/** BPM from tapped times (ms): the median gap of the last few taps, after any long pause. */
export function tapTempo(tapsMs: readonly number[]): number | null {
  let start = tapsMs.length - 1;
  while (start > 0 && tapsMs[start] - tapsMs[start - 1] <= 2000 && tapsMs.length - start < 6) start--;
  const recent = tapsMs.slice(start);
  if (recent.length < 2) return null;
  const gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
  const middle = gaps.length / 2;
  const gap = gaps.length % 2 ? gaps[Math.floor(middle)] : (gaps[middle - 1] + gaps[middle]) / 2;
  return gap > 0 ? 60000 / gap : null;
}
