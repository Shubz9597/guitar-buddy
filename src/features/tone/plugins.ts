// Reads REAPER's plugin scan cache (reaper-vstplugins64.ini) so recipes can
// prefer plugins the player already owns.
//
// Each entry looks like:
//   TAL_Chorus_LX.vst3=002B3FA8BFBBD901,1681724913{5653...7275,TAL-Chorus-LX (TAL-Togu Audio Line)
//   reaeq.dll=00E2...,1919247729,ReaEQ (Cockos)
// i.e. file=timestamp,id,display name ("!!!VSTi" marks instruments).

export interface InstalledPlugin {
  /** Name REAPER shows and accepts in TrackFX_AddByName, e.g. "VST3: ReaEQ (Cockos)". */
  fxName: string;
  name: string;
  vendor: string;
  format: "VST3" | "VST";
  instrument: boolean;
  file: string;
}

const ENTRY = /^([^=\s][^=]*\.(vst3|dll))=[0-9A-Fa-f]*,[^,]*,(.+)$/;

export function parsePluginIni(ini: string): InstalledPlugin[] {
  const seen = new Set<string>();
  const plugins: InstalledPlugin[] = [];
  for (const line of ini.split(/\r?\n/)) {
    const match = ENTRY.exec(line.trim());
    if (!match) continue;
    const [, file, ext, rawName] = match;
    const instrument = rawName.endsWith("!!!VSTi");
    const display = rawName.replace(/!!!VSTi$/, "").trim();
    // Shell plugins with no name of their own are listed as "<SHELL>" etc.
    if (!display || display.startsWith("<")) continue;
    const vendorMatch = /^(.*)\s+\(([^()]*)\)$/.exec(display);
    const format = ext.toLowerCase() === "vst3" ? "VST3" : "VST";
    const fxName = `${format}${instrument ? "i" : ""}: ${display}`;
    if (seen.has(fxName)) continue;
    seen.add(fxName);
    plugins.push({
      fxName,
      name: vendorMatch ? vendorMatch[1] : display,
      vendor: vendorMatch ? vendorMatch[2] : "",
      format,
      instrument,
      file,
    });
  }
  return plugins;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Finds an installed plugin by a loose name ("tal chorus", "Archetype Nolly").
 * VST3 wins over VST2 when both exist, matching REAPER's default preference.
 */
export function findPlugin(plugins: InstalledPlugin[], query: string): InstalledPlugin | undefined {
  const q = normalise(query.replace(/^(VST3?i?|JS|CLAP):\s*/i, ""));
  const ranked = plugins
    .filter((p) => !p.instrument)
    .map((p) => {
      const name = normalise(p.name);
      const full = normalise(`${p.name} ${p.vendor}`);
      const score = name === q ? 3 : full === q ? 3 : name.includes(q) || full.includes(q) ? 2 : q.includes(name) ? 1 : 0;
      return { p, score: score * 2 + (p.format === "VST3" ? 1 : 0) };
    })
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.p;
}

/** Guitar-relevant plugins the probe captures params for; missing ones are skipped. */
export const PROBE_LIST = [
  "ReaTune", "ReaGate", "ReaComp", "ReaEQ", "ReaDelay", "ReaVerbate",
  "Archetype Nolly", "Archetype John Mayer X", "NeuralAmpModeler", "Gateway",
  "TAL-Chorus-LX", "Re-Guitar", "AcouFiend", "ValhallaSupermassive", "TDR Kotelnikov",
];
