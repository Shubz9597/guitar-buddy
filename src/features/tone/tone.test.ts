import { describe, expect, it } from "vitest";
import { findPlugin, parsePluginIni } from "./plugins";
import { parseRecipe, RecipeError } from "./recipe";
import { buildParamProbeScript, buildReaperScript } from "./reaper-script";

// Lines copied from a real reaper-vstplugins64.ini.
const INI = `[vstcache]
reaeq.dll=00E2E3494954DD01,1919247729,ReaEQ (Cockos)
reasamplomatic.dll=00E2E3494954DD01,1920167789,ReaSamplOmatic5000 (Cockos)!!!VSTi
Archetype_Nolly.vst3=00447DF2A2DFD601,2019346731{ABCDEF019182FAEB4E4453504E414E50,Archetype Nolly (Neural DSP)
Archetype_Nolly.dll=00447DF2A2DFD601,1312902736,Archetype Nolly (Neural DSP)
TAL_Chorus_LX.vst3=002B3FA8BFBBD901,1681724913{56535463484C3174616C2D63686F7275,TAL-Chorus-LX (TAL-Togu Audio Line)
BC_Re_Guitar_VST3.vst3=00927AAE0F1BDC01,1206276787{F3306F878E974018B4C9916AD73BA87E,Blue Cat's Re-Guitar (Blue Cat Audio)
broken line without equals
`;

const RECIPE = {
  song: "Kill the King",
  artist: "Megadeth",
  tuning: "E A D G B E",
  sections: [
    {
      name: "Rhythm",
      playing: "Bridge humbucker, volume 10",
      chain: [
        { kind: "tuner", plugin: "VST: ReaTune (Cockos)", params: [], confidence: "confirmed" },
        {
          kind: "amp",
          plugin: "VST3: Archetype Nolly (Neural DSP)",
          emulates: 'Marshall JCM800 "modded"',
          params: [{ name: "Gain", value: 0.6 }],
          confidence: "likely",
        },
      ],
    },
  ],
  sources: ["https://example.com/interview"],
};

describe("parsePluginIni", () => {
  const plugins = parsePluginIni(INI);

  it("reads effects and instruments with REAPER's FX names", () => {
    expect(plugins.map((p) => p.fxName)).toEqual([
      "VST: ReaEQ (Cockos)",
      "VSTi: ReaSamplOmatic5000 (Cockos)",
      "VST3: Archetype Nolly (Neural DSP)",
      "VST: Archetype Nolly (Neural DSP)",
      "VST3: TAL-Chorus-LX (TAL-Togu Audio Line)",
      "VST3: Blue Cat's Re-Guitar (Blue Cat Audio)",
    ]);
    expect(plugins[1].instrument).toBe(true);
    expect(plugins[4]).toMatchObject({ name: "TAL-Chorus-LX", vendor: "TAL-Togu Audio Line" });
  });

  it("finds plugins by loose name and prefers VST3", () => {
    expect(findPlugin(plugins, "archetype nolly")?.fxName).toBe("VST3: Archetype Nolly (Neural DSP)");
    expect(findPlugin(plugins, "TAL Chorus")?.fxName).toBe("VST3: TAL-Chorus-LX (TAL-Togu Audio Line)");
    expect(findPlugin(plugins, "VST: ReaEQ")?.fxName).toBe("VST: ReaEQ (Cockos)");
    expect(findPlugin(plugins, "re-guitar")?.vendor).toBe("Blue Cat Audio");
    expect(findPlugin(plugins, "ReaSamplOmatic5000")).toBeUndefined();
    expect(findPlugin(plugins, "Fortin Nameless")).toBeUndefined();
  });
});

describe("parseRecipe", () => {
  it("accepts a valid recipe and fills defaults", () => {
    const recipe = parseRecipe(RECIPE);
    expect(recipe.sections[0].chain[0].bypassed).toBe(false);
    expect(recipe.suggestions).toEqual([]);
  });

  it("rejects out-of-range params with a path to the problem", () => {
    const bad = structuredClone(RECIPE);
    bad.sections[0].chain[1].params[0].value = 7;
    expect(() => parseRecipe(bad)).toThrow(RecipeError);
    expect(() => parseRecipe(bad)).toThrow("sections[0].chain[1].params[0].value");
  });

  it("rejects unknown block kinds and empty chains", () => {
    const badKind = structuredClone(RECIPE) as { sections: { chain: { kind: string }[] }[] };
    badKind.sections[0].chain[0].kind = "fuzzbox";
    expect(() => parseRecipe(badKind)).toThrow("unknown block kind");
    expect(() => parseRecipe({ ...RECIPE, sections: [{ name: "x", chain: [] }] })).toThrow("at least one block");
  });
});

describe("buildReaperScript", () => {
  const script = buildReaperScript(parseRecipe(RECIPE), { newProject: false });

  it("embeds every block, param and label as escaped Lua strings", () => {
    expect(script).toContain('fx = "VST3: Archetype Nolly (Neural DSP)"');
    expect(script).toContain('{ name = "Gain", value = 0.6 }');
    expect(script).toContain('label = "amp: Marshall JCM800 \\"modded\\""');
    expect(script).toContain("local NEW_PROJECT = false");
  });

  it("can start a new project", () => {
    expect(buildReaperScript(parseRecipe(RECIPE), { newProject: true })).toContain("local NEW_PROJECT = true");
  });

  it("puts tuning and playing advice in the project notes", () => {
    expect(script).toContain('local NOTES = "Kill the King - Megadeth | tuning E A D G B E\\nRhythm: Bridge humbucker, volume 10"');
  });
});

describe("buildParamProbeScript", () => {
  it("lists the requested plugins", () => {
    const script = buildParamProbeScript(["VST3: TAL-Chorus-LX (TAL-Togu Audio Line)", 'Odd "name"']);
    expect(script).toContain('local PLUGINS = { "VST3: TAL-Chorus-LX (TAL-Togu Audio Line)", "Odd \\"name\\"" }');
    expect(script).toContain("param-probe.json");
  });
});
