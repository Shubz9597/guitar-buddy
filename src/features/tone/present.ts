// Turns recipe data into what the Tone screen shows: tuning as six strings,
// plugin settings grouped by the block they belong to, and readable sources.

import type { ParamSetting } from "./recipe.ts";

const STANDARD = ["E", "A", "D", "G", "B", "E"];

const NAMED_TUNINGS: Record<string, string> = {
  "E A D G B E": "Standard",
  "D A D G B E": "Drop D",
  "Eb Ab Db Gb Bb Eb": "Half step down",
  "D# G# C# F# A# D#": "Half step down",
  "D G C F A D": "Whole step down",
  "C G C F A D": "Drop C",
  "D A D G A D": "DADGAD",
  "C# F# B E G# C#": "Drop C#",
};

export interface TuningString {
  note: string;
  /** Differs from standard tuning, so the player has to retune it. */
  changed: boolean;
}

export interface Tuning {
  strings?: TuningString[];
  name: string;
}

/** "D A D F A E" -> six strings low to high plus a name; free text falls back to the name only. */
export function parseTuning(text: string | undefined): Tuning | undefined {
  if (!text?.trim()) return undefined;
  // Six notes in a row, separated only by spaces, commas or dashes.
  const note = String.raw`[A-G](?:#|b)?(?![a-z#])`;
  const run = new RegExp(String.raw`(?<![A-Za-z#])${note}(?:[\s,\-]+${note}){5}(?![\s,\-]*[A-G](?![a-z]))`).exec(text);
  const notes = run?.[0].match(new RegExp(note, "g")) ?? [];
  if (notes.length !== 6) return { name: text.trim() };
  const key = notes.join(" ");
  const flats: Record<string, string> = { "D#": "Eb", "G#": "Ab", "C#": "Db", "F#": "Gb", "A#": "Bb" };
  const equal = (a: string, b: string) => a === b || flats[a] === b || flats[b] === a;
  return {
    strings: notes.map((note, i) => ({ note, changed: !equal(note, STANDARD[i]) })),
    name: NAMED_TUNINGS[key] ?? "Custom",
  };
}

export interface ParamGroup {
  /** Block inside the plugin ("OD1", "Rhythm", "Cab 1"); "" for loose settings. */
  name: string;
  /** On/off when the group has an "Active"/"On" switch. */
  enabled?: boolean;
  /** knob is set (0-10) for settings drawn as an amp knob. */
  params: { label: string; value: string; knob?: number }[];
}

const SWITCH_NAMES = new Set(["active", "on", "enabled"]);
const ON_VALUES = new Set(["active", "on", "enabled", "1"]);

export interface ParamKinds {
  /** 0/1 params that are on/off switches. */
  isSwitch?: (name: string) => boolean;
  /** 0..1 knobs, shown on the 0-10 scale a guitarist reads off an amp. */
  isKnob?: (name: string) => boolean;
  /** Unit to add when the plugin's display has none. */
  unitOf?: (name: string) => string | undefined;
}

function display(name: string, value: ParamSetting["value"], kinds: ParamKinds): string {
  if (typeof value === "number") return `${Math.round(value * 100)}%`;
  if (kinds.isSwitch?.(name) && (value === "0" || value === "1")) return value === "1" ? "On" : "Off";
  if (kinds.isKnob?.(name) && /^\d*\.?\d+$/.test(value)) return (Number(value) * 10).toFixed(1);
  const unit = kinds.unitOf?.(name);
  const shown = unit && /^[-+]?\d*\.?\d+$/.test(value.trim()) ? `${value.trim()} ${unit}` : value.replace(/\s*:\s*1$/, ":1");
  // A true minus sign lines up with the digits; a hyphen looks like a gap.
  return shown.replace(/^-(?=\d)/, "−");
}

/** Values that are a plain on/off state, shown as a pill. */
export const isOnOff = (value: string) => /^(on|off|active|inactive)$/i.test(value);
export const isOn = (value: string) => /^(on|active)$/i.test(value);

/**
 * Groups settings by their shared leading words, the way amp plugins name
 * their blocks: "OD1 Drive", "OD1 Tone" -> group "OD1" with "Drive", "Tone".
 * A setting joins the longest prefix shared by three settings, or by two when
 * one of them is the block's on/off switch ("Reverb Active", "Reverb Decay").
 */
export function groupParams(params: ParamSetting[], kinds: ParamKinds = {}): ParamGroup[] {
  const words = params.map((p) => p.name.split(/\s+/));
  const prefixCount = new Map<string, number>();
  for (const w of words) {
    for (let k = 1; k < w.length; k++) {
      const prefix = w.slice(0, k).join(" ");
      prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + 1);
    }
  }
  const switched = new Set(
    words.filter((w) => w.length > 1 && SWITCH_NAMES.has(w.at(-1)!.toLowerCase())).map((w) => w.slice(0, -1).join(" ")),
  );
  const groups = new Map<string, ParamGroup>();
  params.forEach((param, i) => {
    const w = words[i];
    let name = "";
    for (let k = w.length - 1; k >= 1; k--) {
      const prefix = w.slice(0, k).join(" ");
      const count = prefixCount.get(prefix) ?? 0;
      if (count >= 3 || (count >= 2 && switched.has(prefix))) {
        name = prefix;
        break;
      }
    }
    const label = name ? w.slice(name.split(" ").length).join(" ") : param.name;
    const group = groups.get(name) ?? { name, params: [] };
    groups.set(name, group);
    if (name && SWITCH_NAMES.has(label.toLowerCase())) {
      group.enabled = ON_VALUES.has(String(param.value).toLowerCase());
    } else {
      const knob =
        typeof param.value === "string" && kinds.isKnob?.(param.name) && /^\d*\.?\d+$/.test(param.value)
          ? Number(param.value) * 10
          : undefined;
      group.params.push({ label, value: display(param.name, param.value, kinds), ...(knob === undefined ? {} : { knob }) });
    }
  });
  // Loose settings first, then blocks in the order they first appear.
  const loose = groups.get("");
  groups.delete("");
  return [...(loose ? [loose] : []), ...groups.values()].filter((g) => g.params.length > 0 || g.enabled !== undefined);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Product - why it helps" -> { product, reason }, falling back to the opening phrase as the product. */
export function splitSuggestion(text: string): { product?: string; reason: string } {
  const dash = /^(.{3,90}?)\s+[-–—:]\s+(.+)$/s.exec(text);
  if (dash) return { product: dash[1], reason: capitalise(dash[2].trim()) };
  const phrase = /^(.{12,120}?)\s+(?=(?:as|for|to|so|because|which|that)\s)/.exec(text);
  if (phrase) return { product: phrase[1], reason: capitalise(text.slice(phrase[0].length).trim()) };
  return { reason: capitalise(text.trim()) };
}

/** "Main rhythm (intro, verses, choruses)" -> title "Main rhythm", detail "intro, verses, choruses". */
export function splitPartName(name: string): { title: string; detail?: string } {
  const match = /^(.+?)\s*\((.+)\)\s*$/.exec(name);
  return match ? { title: match[1], detail: match[2] } : { title: name };
}

/** Playing advice as short points, one per sentence. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "https://www.equipboard.com/pros/dave-mustaine" -> site "equipboard.com", page "pros/dave-mustaine". */
export function describeSource(url: string): { site: string; page: string } {
  try {
    const u = new URL(url);
    const page = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
    return { site: u.hostname.replace(/^www\./, ""), page };
  } catch {
    return { site: url, page: "" };
  }
}

/** Saved tone ids are "Artist - Song". */
export function splitSavedId(id: string): { artist: string; song: string } {
  const at = id.indexOf(" - ");
  return at < 0 ? { artist: "", song: id } : { artist: id.slice(0, at), song: id.slice(at + 3) };
}
