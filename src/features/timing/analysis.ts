/** Attacks per beat: quarter notes, eighths, eighth-note triplets, sixteenths. */
export type Subdivision = 1 | 2 | 3 | 4;
export type SubdivisionSetting = Subdivision | "auto";

export const SUBDIVISIONS: readonly Subdivision[] = [1, 2, 3, 4];

export const SUBDIVISION_NAMES: Record<Subdivision, string> = {
  1: "quarter notes",
  2: "eighth notes",
  3: "triplets (12ths)",
  4: "sixteenth notes",
};

/** Within this many ms of the grid counts as on time. */
export const TIGHT_MS = 20;
/** Beyond this many ms a hit is clearly early or late. */
export const LOOSE_MS = 45;

export type HitGrade = "tight" | "close" | "off";

export function gradeHit(errorMs: number): HitGrade {
  const size = Math.abs(errorMs);
  if (size <= TIGHT_MS) return "tight";
  if (size <= LOOSE_MS) return "close";
  return "off";
}

/** Signed distance to the nearest grid line: negative is early, positive is late. */
export function gridErrorMs(timeMs: number, originMs: number, slotMs: number): number {
  const position = (timeMs - originMs) / slotMs;
  return (position - Math.round(position)) * slotMs;
}

// A pulse can be read up to 12% away from the click before it is compared
// with the neighbouring subdivision instead (3:4 is only 33% apart).
const CLICK_SPAN = 0.12;
const FIT_SIGMA = 0.1;
const MIN_FIT = 0.45;
const MAX_MULTIPLE = 8;
// Attacks this far off the player's own pulse are treated as stray.
const OUTLIER_SHARE = 0.3;

/**
 * How well the gaps between attacks fit whole multiples of `pulseMs`, from 0
 * to 1. Rests (2x, 3x... gaps) fit; gaps shorter than the pulse do not.
 */
export function pulseFit(intervalsMs: readonly number[], pulseMs: number): number {
  if (intervalsMs.length === 0) return 0;
  let total = 0;
  for (const interval of intervalsMs) {
    const ratio = interval / pulseMs;
    const multiple = Math.round(ratio);
    if (multiple < 1 || multiple > MAX_MULTIPLE) continue;
    const error = ratio - multiple;
    total += Math.exp(-(error * error) / (2 * FIT_SIGMA * FIT_SIGMA));
  }
  return total / intervalsMs.length;
}

function bestPulse(intervalsMs: readonly number[], lowMs: number, highMs: number, steps: number) {
  let best = { pulseMs: lowMs, fit: -1 };
  const ratio = (highMs / lowMs) ** (1 / (steps - 1));
  for (let step = 0, pulseMs = lowMs; step < steps; step += 1, pulseMs *= ratio) {
    const fit = pulseFit(intervalsMs, pulseMs);
    if (fit > best.fit) best = { pulseMs, fit };
  }
  return best;
}

/** Largest pulse that explains the gaps nearly as well as any pulse, when the click is no guide. */
function freePulse(intervalsMs: readonly number[]) {
  const candidates: { pulseMs: number; fit: number }[] = [];
  const steps = 260;
  const ratio = (2000 / 60) ** (1 / (steps - 1));
  for (let step = 0, pulseMs = 60; step < steps; step += 1, pulseMs *= ratio) {
    candidates.push({ pulseMs, fit: pulseFit(intervalsMs, pulseMs) });
  }
  const top = Math.max(...candidates.map((candidate) => candidate.fit));
  if (top < MIN_FIT) return null;
  const good = candidates.filter((candidate) => candidate.fit >= top * 0.9);
  return good[good.length - 1];
}

export interface PulseLine {
  pulseMs: number;
  originMs: number;
  /** Standard deviation of attacks around the fitted pulse. */
  spreadMs: number;
  used: number;
}

function regress(points: readonly { slot: number; timeMs: number }[]) {
  const count = points.length;
  let meanSlot = 0;
  let meanTime = 0;
  for (const point of points) {
    meanSlot += point.slot / count;
    meanTime += point.timeMs / count;
  }
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    covariance += (point.slot - meanSlot) * (point.timeMs - meanTime);
    variance += (point.slot - meanSlot) ** 2;
  }
  const pulseMs = variance > 0 ? covariance / variance : 0;
  return { pulseMs, originMs: meanTime - pulseMs * meanSlot };
}

/**
 * Fits attack times to a straight line `origin + slot * pulse`. Slot numbers
 * come from the gaps, so rests and steady drift are both handled; attacks far
 * from the line (stray noise, flams) are excluded.
 */
export function fitPulseLine(onsetsMs: readonly number[], pulseGuessMs: number): PulseLine | null {
  if (onsetsMs.length < 3) return null;
  let points: { slot: number; timeMs: number }[] = [{ slot: 0, timeMs: onsetsMs[0] }];
  for (let i = 1; i < onsetsMs.length; i += 1) {
    const last = points[points.length - 1];
    const steps = Math.round((onsetsMs[i] - last.timeMs) / pulseGuessMs);
    if (steps < 1) continue;
    points.push({ slot: last.slot + steps, timeMs: onsetsMs[i] });
  }
  if (points.length < 3) return null;

  let line = regress(points);
  for (let pass = 0; pass < 2; pass += 1) {
    const limit = OUTLIER_SHARE * line.pulseMs;
    // Re-number every attack against the current line, keeping the closest
    // attack per slot, then refit.
    const bySlot = new Map<number, { slot: number; timeMs: number; error: number }>();
    for (const timeMs of onsetsMs) {
      const slot = Math.round((timeMs - line.originMs) / line.pulseMs);
      const error = Math.abs(timeMs - (line.originMs + slot * line.pulseMs));
      const existing = bySlot.get(slot);
      if (error <= limit && (!existing || error < existing.error)) bySlot.set(slot, { slot, timeMs, error });
    }
    if (bySlot.size < 3) return null;
    points = [...bySlot.values()];
    line = regress(points);
    if (!(line.pulseMs > 0)) return null;
  }

  let squares = 0;
  for (const point of points) {
    squares += (point.timeMs - (line.originMs + point.slot * line.pulseMs)) ** 2;
  }
  return {
    pulseMs: line.pulseMs,
    originMs: line.originMs,
    spreadMs: Math.sqrt(squares / Math.max(1, points.length - 2)),
    used: points.length,
  };
}

export interface TempoReading {
  bpm: number;
  subdivision: Subdivision;
  /** Standard deviation of attacks around the player's own pulse. */
  spreadMs: number;
  /** False when the playing is too far from the click tempo to be compared with it. */
  followsClick: boolean;
  attacks: number;
}

export const MIN_ATTACKS_FOR_TEMPO = 6;

/**
 * Measures the tempo the guitarist is actually playing.
 *
 * The click tempo is used as the reference: each subdivision's pulse is
 * searched within ±12% of the click, and the coarsest subdivision that
 * explains the gaps is chosen, so eighth notes are never read as double-time
 * quarter notes. The final tempo comes from a line fit over all attacks.
 */
export function estimateTempo(
  onsetsMs: readonly number[],
  beatMs: number,
  setting: SubdivisionSetting,
  fallback?: Subdivision,
): TempoReading | null {
  if (onsetsMs.length < MIN_ATTACKS_FOR_TEMPO) return null;
  const intervals = onsetsMs.slice(1).map((time, i) => time - onsetsMs[i]);
  const candidates = setting === "auto" ? SUBDIVISIONS : [setting];

  const fits = candidates.map((subdivision) => {
    const pulseMs = beatMs / subdivision;
    return { subdivision, ...bestPulse(intervals, pulseMs * (1 - CLICK_SPAN), pulseMs * (1 + CLICK_SPAN), 49) };
  });
  const top = Math.max(...fits.map((fit) => fit.fit));

  let choice: { subdivision: Subdivision; pulseMs: number; followsClick: boolean };
  if (top >= MIN_FIT) {
    const chosen = fits.find((fit) => fit.fit >= Math.max(MIN_FIT, top * 0.85))!;
    choice = { ...chosen, followsClick: true };
  } else {
    const free = freePulse(intervals);
    if (!free) return null;
    const subdivision =
      setting !== "auto"
        ? setting
        : (fallback ?? SUBDIVISIONS.find((d) => 60000 / (free.pulseMs * d) <= 200) ?? 4);
    choice = { subdivision, pulseMs: free.pulseMs, followsClick: false };
  }

  const line = fitPulseLine(onsetsMs, choice.pulseMs);
  // Random hits can always be forced onto some fine pulse; real playing puts
  // most attacks close to it.
  if (
    !line ||
    line.used < MIN_ATTACKS_FOR_TEMPO - 1 ||
    line.used < onsetsMs.length * 0.75 ||
    line.spreadMs > line.pulseMs * 0.15
  ) {
    return null;
  }
  return {
    bpm: 60000 / (line.pulseMs * choice.subdivision),
    subdivision: choice.subdivision,
    spreadMs: line.spreadMs,
    followsClick: choice.followsClick,
    attacks: line.used,
  };
}

/**
 * The attacks of the current phrase: the most recent run without a long
 * silence, limited to the last 12 seconds.
 */
export function currentPhrase(onsetsMs: readonly number[], beatMs: number): number[] {
  if (onsetsMs.length === 0) return [];
  const maxGap = Math.max(2000, beatMs * 2.5);
  const last = onsetsMs[onsetsMs.length - 1];
  let first = onsetsMs.length - 1;
  while (first > 0 && onsetsMs[first] - onsetsMs[first - 1] <= maxGap && last - onsetsMs[first - 1] <= 12000) {
    first -= 1;
  }
  return onsetsMs.slice(first);
}

export interface HitSummary {
  count: number;
  /** Average signed error: negative rushes, positive drags. */
  meanMs: number;
  /** Standard deviation of the errors. */
  spreadMs: number;
  /** Share of hits within TIGHT_MS, 0..100. */
  tightPercent: number;
}

export function summarizeHits(errorsMs: readonly number[]): HitSummary | null {
  if (errorsMs.length === 0) return null;
  const count = errorsMs.length;
  const meanMs = errorsMs.reduce((sum, error) => sum + error, 0) / count;
  const variance = errorsMs.reduce((sum, error) => sum + (error - meanMs) ** 2, 0) / count;
  const tight = errorsMs.filter((error) => Math.abs(error) <= TIGHT_MS).length;
  return { count, meanMs, spreadMs: Math.sqrt(variance), tightPercent: Math.round((tight / count) * 100) };
}

const SYLLABLES: Record<Subdivision, readonly string[]> = {
  1: [""],
  2: ["", "&"],
  3: ["", "trip", "let"],
  4: ["", "e", "&", "a"],
};

/** The counting syllable of a position within the beat: "" for the beat itself, then "e", "&", "a"... */
export function syllable(indexInBeat: number, subdivision: Subdivision): string {
  return SYLLABLES[subdivision][indexInBeat] ?? "";
}

/** How a grid slot is counted, e.g. "3", "3 e", "2 &". `slot` counts from beat 1 of a bar. */
export function countName(slot: number, subdivision: Subdivision, beatsPerBar: number): string {
  const positive = ((slot % (subdivision * beatsPerBar)) + subdivision * beatsPerBar) % (subdivision * beatsPerBar);
  const beat = Math.floor(positive / subdivision) + 1;
  const sub = syllable(positive % subdivision, subdivision);
  return sub ? `${beat} ${sub}` : String(beat);
}

export interface CountStats {
  /** Position within the beat: 0 is the beat, then e, &, a... */
  index: number;
  syllable: string;
  meanMs: number;
  spreadMs: number;
  count: number;
}

/** Timing grouped by position within the beat, so "your a's are early" becomes visible. */
export function statsByCount(
  hits: readonly { slot: number; errorMs: number }[],
  subdivision: Subdivision,
): CountStats[] {
  return Array.from({ length: subdivision }, (_, index) => {
    const errors = hits
      .filter((hit) => ((hit.slot % subdivision) + subdivision) % subdivision === index)
      .map((hit) => hit.errorMs);
    const summary = summarizeHits(errors);
    return {
      index,
      syllable: syllable(index, subdivision),
      meanMs: summary?.meanMs ?? 0,
      spreadMs: summary?.spreadMs ?? 0,
      count: errors.length,
    };
  });
}

export interface OnsetPoint {
  timeMs: number;
  strength: number;
}

/**
 * Shortest gap allowed between two real notes: 60% of a sixteenth, since
 * nothing the trainer checks is faster. Kept between 30 and 110 ms.
 */
export const ghostWindowMs = (beatMs: number) => Math.max(30, Math.min(110, (beatMs / 4) * 0.6));

/**
 * Palm mutes and high gain add weak "ghost" attacks 40-70 ms before (or
 * after) a note: pick scrape and string noise. Of attacks closer together
 * than `windowMs`, only the strongest is a note. Without this, whichever of
 * two attacks is closer to the click gets matched, flattering sloppy timing.
 */
export function dropGhosts(onsets: readonly OnsetPoint[], windowMs: number): OnsetPoint[] {
  const kept: OnsetPoint[] = [];
  for (const onset of onsets) {
    const last = kept.at(-1);
    if (last && onset.timeMs - last.timeMs < windowMs) {
      if (onset.strength > last.strength) kept[kept.length - 1] = onset;
      continue;
    }
    kept.push(onset);
  }
  return kept;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
