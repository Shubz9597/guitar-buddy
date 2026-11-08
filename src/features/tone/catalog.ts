// The player's plugin catalog: every tone parameter of their installed
// guitar plugins, as captured by the probe script (param-probe.json). The
// researcher is shown this catalog and its recipes are checked against it,
// so a recipe only ever names plugins, params and values that really exist.

import type { ToneRecipe } from "./recipe.ts";

export interface CatalogParam {
  name: string;
  /** Display value at the plugin's default. */
  shown: string;
  /** Every display value, for switches and menus. */
  options?: string[];
  /** Display values at the two ends of the range, for knobs. */
  min?: string;
  max?: string;
}

export interface CatalogPlugin {
  fx: string;
  params: CatalogParam[];
}

// Host-level params REAPER adds to every plugin; never part of a tone.
const HOST_PARAMS = new Set(["bypass", "wet", "delta"]);

/** Compares names without case, spaces or punctuation, like the Lua side. */
export const paramKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export function parseProbe(json: string): CatalogPlugin[] {
  const raw = JSON.parse(json) as { fx: string; params: (CatalogParam & { index: number; value: number })[] }[];
  return raw.map((plugin) => ({
    fx: plugin.fx,
    params: plugin.params
      .filter((p) => !HOST_PARAMS.has(paramKey(p.name)))
      .map(({ name, shown, options, min, max }) => ({ name, shown, options, min, max })),
  }));
}

/** Params that are plain on/off switches shown as 0 and 1, keyed "fx|paramKey". */
export function binarySwitches(catalog: CatalogPlugin[]): Set<string> {
  const keys = new Set<string>();
  for (const plugin of catalog) {
    for (const p of plugin.params) {
      if (p.options?.length === 2 && [...p.options].sort().join(",") === "0,1") keys.add(`${plugin.fx}|${paramKey(p.name)}`);
    }
  }
  return keys;
}

/** 0..1 knobs with no unit ("0.00" .. "1.00"), keyed "fx|paramKey". */
export function unitKnobs(catalog: CatalogPlugin[]): Set<string> {
  const keys = new Set<string>();
  for (const plugin of catalog) {
    for (const p of plugin.params) {
      if (p.min && p.max && /^0(\.0+)?$/.test(p.min.trim()) && /^1(\.0+)?$/.test(p.max.trim())) keys.add(`${plugin.fx}|${paramKey(p.name)}`);
    }
  }
  return keys;
}

/**
 * Units for params whose display has none (Neural DSP shows "-48.0" for a
 * gate in dB), guessed from the param name. Keyed "fx|paramKey".
 */
export function paramUnits(catalog: CatalogPlugin[]): Map<string, string> {
  const units = new Map<string, string>();
  const bare = (s?: string) => s !== undefined && /^[-+]?\d*\.?\d+$/.test(s.trim());
  for (const plugin of catalog) {
    for (const p of plugin.params) {
      if (!bare(p.min) || !bare(p.max)) continue;
      if (/^0(\.0+)?$/.test(p.min!.trim()) && /^1(\.0+)?$/.test(p.max!.trim())) continue; // 0-10 knob
      const name = p.name;
      const unit = /\bEQ\b/i.test(name) || /(gain|level|gate|threshold|volume|output|input)/i.test(name)
        ? "dB"
        : /(cut|freq)/i.test(name)
          ? "Hz"
          : /(time|decay|pre-?delay)/i.test(name)
            ? "ms"
            : undefined;
      if (unit) units.set(`${plugin.fx}|${paramKey(name)}`, unit);
    }
  }
  return units;
}

/** Compact listing for the model: one line per param with its options or range. */
/**
 * What each plugin sounds like and what its blocks are modelled on. Channel
 * names ("Clean", "Lead") say little, and without this the researcher picked
 * Nolly's modern high-gain Lead head to stand in for a vintage Mesa.
 * Only claims backed by the maker or press are stated as fact.
 */
export const PLUGIN_NOTES: { match: RegExp; note: string }[] = [
  {
    match: /Archetype John Mayer X/i,
    note:
      "Vintage American clean-to-edge rig (John Mayer's studio gear, cabs captured in his studio). Amps: Neural DSP says the three are his 1964 Fender Vibroverb, his Dumble Steel String Singer and his Two-Rock signature prototype #83. " +
      "'Headroom Hero' is the Fender-style black-panel clean (sparkly, lots of headroom; best for 60s-80s clean and Fender/Mesa-clean sounds); 'Smooth Operator' is the Dumble-style smooth, thick clean that breaks up gently; 'Signature 83' is the Two-Rock warm clean/edge; 'Three-In-One' blends them. " +
      "Pedals: Justa Boost (clean boost, modelled on a Keeley Katana), Halfman OD (transparent Klon-type overdrive), Tealbreaker (TS mode = Tube Screamer mid-hump, BB mode = Bluesbreaker-style low-gain), Antelope Filter (envelope filter/auto-wah), Millipede Delay (analog bucket-brigade delay, modelled on a Way Huge Aqua Puss: closest owned match to Boss DM-2/DM-3 style analog delay), Gravity Tank (Fender-style spring reverb and harmonic tremolo), Doubler, Dream Delay, Studio Verb (Plate or Hall). " +
      "No chorus, flanger, fuzz or high-gain distortion: chain TAL-Chorus-LX for chorus, and use Nolly's pedals or amps for heavier drive.",
  },
  {
    match: /Archetype Nolly/i,
    note:
      "Modern rock/metal production rig (Adam 'Nolly' Getgood of Periphery), based on his own modified amps; Neural DSP does not name the originals. " +
      "'Clean' is a modern hi-fi clean (very clear and full; not a vintage Fender or Mesa voice); 'Crunch' is British crunch (Marshall-like); 'Rhythm' and 'Lead' are modern high-gain heads (djent/metal), far too saturated and tight for vintage lead tones. " +
      "Blocks: Comp, OD1 and OD2 overdrive pedals (usable as a boost or Tube Screamer-like drive in front of any amp), Delay-1, Delay-2 (with modulation), Reverb. " +
      "Best for modern rock and metal; for 60s-80s and blues/pop tones prefer John Mayer X amps.",
  },
  {
    match: /TAL-Chorus-LX/i,
    note: "Roland Juno-60 chorus (modes I, II and I+II). The closest owned match to analog Boss CE-1/CE-2 or Roland JC chorus; also usable for a slow, wide 80s chorus. Not a flanger.",
  },
  {
    match: /ValhallaSupermassive/i,
    note: "Huge ambient delay/reverb with long feedback and modulation (shimmer, post-rock, 80s washes). Too big for natural rooms; keep Mix low for a studio ambience.",
  },
  { match: /ReaDelay/i, note: "Plain digital delay. Lower its lowpass to about 3-4 kHz to approximate analog or tape echo." },
  { match: /ReaVerbate/i, note: "Basic algorithmic room reverb. For plate or hall studio reverb, the Studio Verb in John Mayer X sounds better." },
  { match: /ReaEQ/i, note: "Parametric EQ: use it to shape the humbucker toward a single-coil (cut 200-400 Hz, lift 3-5 kHz) or to match the record's EQ." },
  { match: /ReaComp|Kotelnikov/i, note: "Compressor. For a guitar 'squash' pedal (Dyna Comp, Ross) use fast attack, high ratio." },
  { match: /Re-Guitar/i, note: "Turns an electric into an acoustic-like sound." },
  { match: /AcouFiend/i, note: "Simulated amp feedback for endless sustain on held notes." },
  { match: /NeuralAmpModeler|Gateway/i, note: "Loads captures (.nam) and IRs of real amps and pedals; the player must download and load them, so recommend specific captures in gaps instead of using it in chains." },
];

export const pluginNote = (fx: string) => PLUGIN_NOTES.find((n) => n.match.test(fx))?.note;

export function catalogPrompt(catalog: CatalogPlugin[]): string {
  return catalog
    .map((plugin) => {
      const lines = plugin.params.map((p) =>
        p.options ? `${p.name}: ${p.options.join(" | ")}` : `${p.name}: ${p.min ?? "?"} .. ${p.max ?? "?"}`,
      );
      const note = pluginNote(plugin.fx);
      return `### ${plugin.fx}\n${note ? `Models: ${note}\n` : ""}${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** Number in a display string, in base units ("1.2 kHz" -> 1200, "50 ms" -> 0.05). Mirrors parseNum in Lua. */
export function parseDisplayNumber(s: string): number | undefined {
  const l = s.toLowerCase();
  if (l.includes("-inf")) return -1e9;
  if (l.includes("inf")) return 1e9;
  const match = /[-+]?\d*\.?\d+/.exec(l);
  if (!match) return undefined;
  let n = Number(match[0]);
  const unit = /^\s*([a-z]+)/.exec(l.slice(match.index + match[0].length))?.[1];
  if (unit === "ms") n /= 1000;
  else if (unit?.startsWith("k")) n *= 1000;
  return n;
}

function checkValue(param: CatalogParam, value: number | string): string | undefined {
  if (typeof value === "number") return undefined; // normalised 0..1, already range-checked
  if (param.options) {
    if (param.options.some((o) => squash(o) === squash(value))) return undefined;
    // Stepped numeric knobs list their steps as options; allow any number in between.
    const numbers = param.options.map(parseDisplayNumber);
    const n = parseDisplayNumber(value);
    if (n !== undefined && numbers.every((x) => x !== undefined)) {
      const lo = Math.min(...(numbers as number[]));
      const hi = Math.max(...(numbers as number[]));
      if (n >= lo && n <= hi && param.options.length > 3) return undefined;
    }
    return `must be one of ${param.options.join(" | ")}`;
  }
  const n = parseDisplayNumber(value);
  const a = param.min === undefined ? undefined : parseDisplayNumber(param.min);
  const b = param.max === undefined ? undefined : parseDisplayNumber(param.max);
  if (n === undefined) return `must be a number from ${param.min} to ${param.max}`;
  if (a === undefined || b === undefined) return undefined;
  const slack = Math.abs(b - a) * 0.001;
  if (n < Math.min(a, b) - slack || n > Math.max(a, b) + slack) return `must be from ${param.min} to ${param.max}`;
  return undefined;
}

/**
 * Lists everything in a recipe that the player's plugins cannot do. ReaTune
 * and other plugins outside the catalog are allowed as long as they are
 * installed (installedFx), but their params cannot be checked.
 */
export function checkRecipe(recipe: ToneRecipe, catalog: CatalogPlugin[], installedFx: string[] = []): string[] {
  const problems: string[] = [];
  const byFx = new Map(catalog.map((p) => [p.fx, p]));
  const installed = new Set(installedFx);
  if (!recipe.match) problems.push(`"match" is missing: rate the recipe close, partial or far with a summary`);
  if (!recipe.signature?.length) problems.push(`"signature" is missing: list the 2-4 things that make this sound recognisable`);
  if (recipe.match && recipe.match.rating !== "close" && !recipe.gaps?.length) {
    problems.push(`match is "${recipe.match.rating}" but "gaps" is empty: list each piece of gear the plugins only approximate and what to get`);
  }
  recipe.gaps?.forEach((gap, i) => {
    if (gap.impact !== "low" && gap.get.length === 0) problems.push(`gaps[${i}] "${gap.missing}": name 1-3 products in "get"`);
  });
  recipe.sections.forEach((section, i) => {
    section.chain.forEach((block, j) => {
      const where = `sections[${i}] "${section.name}" chain[${j}]`;
      const plugin = byFx.get(block.plugin);
      if (!plugin) {
        if (!installed.has(block.plugin)) problems.push(`${where}: plugin "${block.plugin}" is not installed; use an exact name from the plugin list`);
        return;
      }
      const params = new Map(plugin.params.map((p) => [paramKey(p.name), p]));
      for (const setting of block.params) {
        const param = params.get(paramKey(setting.name));
        if (!param) {
          problems.push(`${where}: "${block.plugin}" has no param "${setting.name}"; use an exact name from its list`);
          continue;
        }
        const issue = checkValue(param, setting.value);
        if (issue) problems.push(`${where}: "${param.name}" = ${JSON.stringify(setting.value)} ${issue}`);
      }
    });
  });
  return problems;
}
