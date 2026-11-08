import { describe, expect, it } from "vitest";
import { describeSource, groupParams, parseTuning, splitPartName, splitSavedId, splitSentences, splitSuggestion } from "./present";

describe("parseTuning", () => {
  it("reads six strings and marks the ones to retune", () => {
    const t = parseTuning("D A D F A E");
    expect(t?.name).toBe("Custom");
    expect(t?.strings?.filter((s) => s.changed).map((s) => s.note)).toEqual(["D", "F", "A"]);
  });

  it("names common tunings and ignores extra words", () => {
    expect(parseTuning("E A D G B E (standard)")?.name).toBe("Standard");
    expect(parseTuning("Drop D: D A D G B E")?.name).toBe("Drop D");
    expect(parseTuning("D# G# C# F# A# D#")?.strings?.every((s) => s.changed)).toBe(true);
  });

  it("keeps free text it cannot split into strings", () => {
    expect(parseTuning("Open G with capo")).toEqual({ name: "Open G with capo" });
    expect(parseTuning(undefined)).toBeUndefined();
  });
});

describe("groupParams", () => {
  it("groups amp-plugin settings by block and reads on/off switches", () => {
    const groups = groupParams([
      { name: "Input Gain", value: "0.0" },
      { name: "Gate", value: "-48.0" },
      { name: "OD1 Active", value: "Active" },
      { name: "OD1 Drive", value: "0.15" },
      { name: "OD1 Tone", value: "0.60" },
      { name: "Amp Type", value: "Rhythm" },
      { name: "Rhythm Gain", value: "0.55" },
      { name: "Rhythm Mid", value: "0.55" },
      { name: "Rhythm High", value: "0.65" },
      { name: "Auto Release", value: "1" },
      { name: "Auto Make Up Gain", value: "1" },
      { name: "Cab 1 Active", value: "On" },
      { name: "Cab 1 Mic IR", value: "Dynamic 57" },
      { name: "Reverb Active", value: "Inactive" },
      { name: "Reverb Decay", value: "1600" },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["", "OD1", "Rhythm", "Cab 1", "Reverb"]);
    // Two settings without a switch ("Auto ...") stay loose rather than forming a thin group.
    expect(groups[0].params.map((p) => p.label)).toEqual(["Input Gain", "Gate", "Amp Type", "Auto Release", "Auto Make Up Gain"]);
    expect(groups[1]).toEqual({ name: "OD1", enabled: true, params: [{ label: "Drive", value: "0.15" }, { label: "Tone", value: "0.60" }] });
    expect(groups[3].params).toEqual([{ label: "Mic IR", value: "Dynamic 57" }]);
    expect(groups[4].enabled).toBe(false);
  });

  it("shows 0/1 switches as On and Off when the plugin says they are switches", () => {
    const params = [{ name: "Auto Release", value: "1" }, { name: "Auto Make Up Gain", value: "0" }, { name: "Ratio", value: "1" }];
    const groups = groupParams(params, { isSwitch: (name) => name.startsWith("Auto") });
    expect(groups[0].params.map((p) => p.value)).toEqual(["On", "Off", "1"]);
  });

  it("shows 0..1 knobs on a 0-10 scale and tidies ratios", () => {
    const params = [{ name: "Gain", value: "0.55" }, { name: "Gate", value: "-48.0" }, { name: "Ratio", value: "2.000 :1" }];
    const groups = groupParams(params, { isKnob: (name) => name === "Gain" });
    expect(groups[0].params.map((p) => p.value)).toEqual(["5.5", "−48.0", "2.000:1"]);
    expect(groups[0].params[0].knob).toBe(5.5);
    expect(groups[0].params[1].knob).toBeUndefined();
  });

  it("shows normalised numbers as percentages", () => {
    expect(groupParams([{ name: "Dry/Wet", value: 0.3 }])[0].params[0].value).toBe("30%");
  });
});

describe("part names and playing advice", () => {
  it("splits a part name into title and detail", () => {
    expect(splitPartName("Main rhythm (intro, verses, choruses)")).toEqual({ title: "Main rhythm", detail: "intro, verses, choruses" });
    expect(splitPartName("Solo")).toEqual({ title: "Solo" });
  });

  it("splits advice into sentences", () => {
    expect(splitSentences("Bridge humbucker, volume 10. Pick hard - no drop D. Mute the low strings.")).toEqual([
      "Bridge humbucker, volume 10.",
      "Pick hard - no drop D.",
      "Mute the low strings.",
    ]);
  });

  it("adds units the plugin leaves out", () => {
    const groups = groupParams([{ name: "Gate", value: "-48.0" }, { name: "Amp Type", value: "Rhythm" }], { unitOf: (n) => (n === "Gate" ? "dB" : undefined) });
    expect(groups[0].params.map((p) => p.value)).toEqual(["−48.0 dB", "Rhythm"]);
  });
});

describe("text helpers", () => {
  it("splits suggestions into product and reason", () => {
    expect(splitSuggestion("OwnHammer G12M-25 IR pack - the Greenbacks are the sound")).toEqual({
      product: "OwnHammer G12M-25 IR pack",
      reason: "The Greenbacks are the sound",
    });
    expect(splitSuggestion("just some advice")).toEqual({ reason: "Just some advice" });
    expect(splitSuggestion("Free JCM-style NAM profiles on tone3000 as a second option")).toEqual({
      product: "Free JCM-style NAM profiles on tone3000",
      reason: "As a second option",
    });
  });

  it("describes sources by site and page", () => {
    expect(describeSource("https://www.equipboard.com/pros/dave-mustaine")).toEqual({ site: "equipboard.com", page: "pros/dave-mustaine" });
    expect(describeSource("not a url").site).toBe("not a url");
  });

  it("splits saved ids into artist and song", () => {
    expect(splitSavedId("Pink Floyd - High Hopes")).toEqual({ artist: "Pink Floyd", song: "High Hopes" });
    expect(splitSavedId("Untitled")).toEqual({ artist: "", song: "Untitled" });
  });
});
