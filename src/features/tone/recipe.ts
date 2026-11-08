// A tone recipe describes how to rebuild a song's guitar sound in REAPER:
// one section per distinct tone (clean intro, rhythm, solo...), each an
// ordered FX chain. Recipes come from the AI researcher or are written by
// hand, so everything is validated before it is turned into a script.

import type { SongMatch } from "./songs.ts";

export type BlockKind =
  | "tuner"
  | "gate"
  | "comp"
  | "drive"
  | "amp"
  | "cab"
  | "eq"
  | "mod"
  | "delay"
  | "reverb"
  | "other";

export type Confidence = "confirmed" | "likely" | "guess";

export interface ParamSetting {
  /** Parameter name as REAPER reports it; matched case-insensitively. */
  name: string;
  /**
   * Either a normalised number 0..1, or the value as the plugin displays it
   * ("-12 dB", "4.5", "1.2 kHz", "Rhythm", "On"); REAPER converts text values
   * by searching the param's own display strings.
   */
  value: number | string;
}

export interface FxBlock {
  kind: BlockKind;
  /** REAPER FX name, e.g. "VST3: TAL-Chorus-LX (TAL-Togu Audio Line)". */
  plugin: string;
  /** Plugin preset to load before params are applied. */
  preset?: string;
  params: ParamSetting[];
  /** What this block imitates on the record, e.g. "Ibanez TS9". */
  emulates?: string;
  confidence: Confidence;
  bypassed?: boolean;
}

export interface Section {
  name: string;
  /** Pickup and guitar knob advice for the player. */
  playing?: string;
  chain: FxBlock[];
}

export interface ToneRecipe {
  song: string;
  artist: string;
  /** Low to high, e.g. "D A D G B E". */
  tuning?: string;
  sections: Section[];
  /** Interviews, rig rundowns etc. that back the recipe. */
  sources: string[];
  /** Gear the player does not own that would get closer, with why (older recipes; new ones use gaps). */
  suggestions?: string[];
  /** The 2-4 things that make the sound recognisable. */
  signature?: string[];
  /** How near the recipe gets with the player's plugins. */
  match?: { rating: MatchRating; summary: string };
  /** Original gear the player's plugins only approximate, and what to get. */
  gaps?: Gap[];
  /** What the sources say on each research topic, with the URLs that say it. */
  facts?: Partial<Record<FactTopic, Fact>>;
  /** The player's corrections ("the intro is Wendy on a Rickenbacker"), oldest first. */
  notes?: string[];
  /** The recording the player picked, so the tone can be researched again. */
  recording?: SongMatch;
}

/** What the researcher must look up for every song. */
export const FACT_TOPICS = ["players", "guitars", "amps", "effects", "studio"] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

export interface Fact {
  finding: string;
  sources: string[];
}

export type MatchRating = "close" | "partial" | "far";
export type Impact = "high" | "medium" | "low";

export interface Gap {
  missing: string;
  impact: Impact;
  /** The stand-in the recipe uses now. */
  using?: string;
  /** "Product (free|paid) - why", best first. */
  get: string[];
}

const RATINGS = new Set<MatchRating>(["close", "partial", "far"]);
const IMPACTS = new Set<Impact>(["high", "medium", "low"]);

function parseMatch(raw: unknown): ToneRecipe["match"] {
  const obj = record(raw, "match");
  const rating = obj.rating as MatchRating;
  if (!RATINGS.has(rating)) fail("match.rating", `expected ${[...RATINGS].join(", ")}`);
  return { rating, summary: text(obj.summary, "match.summary") };
}

function parseGap(raw: unknown, path: string): Gap {
  const obj = record(raw, path);
  const impact = obj.impact as Impact;
  if (!IMPACTS.has(impact)) fail(`${path}.impact`, `expected ${[...IMPACTS].join(", ")}`);
  return {
    missing: text(obj.missing, `${path}.missing`),
    impact,
    using: optionalText(obj.using, `${path}.using`),
    get: list(obj.get ?? [], `${path}.get`).map((g, i) => text(g, `${path}.get[${i}]`)),
  };
}

function parseFacts(raw: unknown): ToneRecipe["facts"] {
  const obj = record(raw, "facts");
  const facts: NonNullable<ToneRecipe["facts"]> = {};
  for (const topic of FACT_TOPICS) {
    if (obj[topic] === undefined) continue;
    const fact = record(obj[topic], `facts.${topic}`);
    facts[topic] = {
      finding: text(fact.finding, `facts.${topic}.finding`),
      sources: list(fact.sources ?? [], `facts.${topic}.sources`).map((s, i) => text(s, `facts.${topic}.sources[${i}]`)),
    };
  }
  return facts;
}

/** Our own field, so a bad value is dropped rather than failing the recipe. */
function parseRecording(raw: unknown): SongMatch | undefined {
  const r = raw as Partial<SongMatch> | null;
  if (typeof r !== "object" || r === null || typeof r.id !== "string" || typeof r.title !== "string" || typeof r.artist !== "string") return undefined;
  const optional = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { id: r.id, title: r.title, artist: r.artist, album: optional(r.album), year: optional(r.year), artwork: optional(r.artwork) };
}

const BLOCK_KINDS = new Set<BlockKind>([
  "tuner", "gate", "comp", "drive", "amp", "cab", "eq", "mod", "delay", "reverb", "other",
]);
const CONFIDENCES = new Set<Confidence>(["confirmed", "likely", "guess"]);

export class RecipeError extends Error {}

function fail(path: string, problem: string): never {
  throw new RecipeError(`${path}: ${problem}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "expected a non-empty string");
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function parseParam(raw: unknown, path: string): ParamSetting {
  const obj = record(raw, path);
  const value = obj.value;
  const validNumber = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const validText = typeof value === "string" && value.trim() !== "";
  if (!validNumber && !validText) {
    fail(`${path}.value`, "expected a number from 0 to 1 or a display value like \"-12 dB\"");
  }
  return { name: text(obj.name, `${path}.name`), value: validNumber ? value : (value as string).trim() };
}

function parseBlock(raw: unknown, path: string): FxBlock {
  const obj = record(raw, path);
  const kind = obj.kind as BlockKind;
  if (!BLOCK_KINDS.has(kind)) fail(`${path}.kind`, `unknown block kind ${JSON.stringify(obj.kind)}`);
  const confidence = obj.confidence as Confidence;
  if (!CONFIDENCES.has(confidence)) fail(`${path}.confidence`, `expected ${[...CONFIDENCES].join(", ")}`);
  return {
    kind,
    plugin: text(obj.plugin, `${path}.plugin`),
    preset: optionalText(obj.preset, `${path}.preset`),
    params: list(obj.params ?? [], `${path}.params`).map((p, i) => parseParam(p, `${path}.params[${i}]`)),
    emulates: optionalText(obj.emulates, `${path}.emulates`),
    confidence,
    bypassed: obj.bypassed === true,
  };
}

/** Validates untrusted JSON (AI output or a file) into a recipe. */
export function parseRecipe(raw: unknown): ToneRecipe {
  const obj = record(raw, "recipe");
  const sections = list(obj.sections, "sections").map((s, i) => {
    const sec = record(s, `sections[${i}]`);
    const chain = list(sec.chain, `sections[${i}].chain`);
    if (chain.length === 0) fail(`sections[${i}].chain`, "needs at least one block");
    return {
      name: text(sec.name, `sections[${i}].name`),
      playing: optionalText(sec.playing, `sections[${i}].playing`),
      chain: chain.map((b, j) => parseBlock(b, `sections[${i}].chain[${j}]`)),
    };
  });
  if (sections.length === 0) fail("sections", "needs at least one section");
  return {
    song: text(obj.song, "song"),
    artist: text(obj.artist, "artist"),
    tuning: optionalText(obj.tuning, "tuning"),
    sections,
    sources: list(obj.sources ?? [], "sources").map((s, i) => text(s, `sources[${i}]`)),
    suggestions: list(obj.suggestions ?? [], "suggestions").map((s, i) => text(s, `suggestions[${i}]`)),
    ...(obj.signature !== undefined && { signature: list(obj.signature, "signature").map((s, i) => text(s, `signature[${i}]`)) }),
    ...(obj.match !== undefined && { match: parseMatch(obj.match) }),
    ...(obj.gaps !== undefined && { gaps: list(obj.gaps, "gaps").map((g, i) => parseGap(g, `gaps[${i}]`)) }),
    ...(obj.facts !== undefined && { facts: parseFacts(obj.facts) }),
    ...(obj.notes !== undefined && { notes: list(obj.notes, "notes").map((n, i) => text(n, `notes[${i}]`)) }),
    ...(parseRecording(obj.recording) && { recording: parseRecording(obj.recording) }),
  };
}
