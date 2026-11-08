import { describe, expect, it } from "vitest";
import { catalogPrompt, checkRecipe, parseDisplayNumber, parseProbe } from "./catalog";
import { parseRecipe } from "./recipe";
import { buildReaperScript } from "./reaper-script";
import { emptyTrace, extractJson, keepFoundSources, researchTone, type ZaiPath } from "./research";

// Shape of a real param-probe.json, trimmed.
const PROBE = JSON.stringify([
  {
    fx: "VST: ReaTune (Cockos)",
    presets: 0,
    params: [{ index: 0, name: "Bypass", value: 0, shown: "normal", options: ["normal", "bypassed"] }],
  },
  {
    fx: "VST3: Archetype Nolly (Neural DSP)",
    presets: 0,
    params: [
      { index: 1, name: "Gate", value: 0.1, shown: "-80.0", min: "-90.0", max: "0.0" },
      { index: 26, name: "Amp Type", value: 0.66, shown: "Rhythm", options: ["Clean", "Crunch", "Rhythm", "Lead"] },
      { index: 44, name: "Rhythm Gain", value: 0.5, shown: "0.50", min: "0.00", max: "1.00" },
      { index: 2214, name: "Wet", value: 1, shown: "100", min: "0", max: "100" },
    ],
  },
  {
    fx: "VST: ReaEQ (Cockos)",
    presets: 24,
    params: [{ index: 3, name: "Freq-Band 2", value: 0.3, shown: "300.0", min: "20.0 Hz", max: "24000.0 Hz" }],
  },
]);

const catalog = parseProbe(PROBE);

const recipe = (params: { name: string; value: string | number }[]) =>
  parseRecipe({
    song: "Kill the King",
    artist: "Megadeth",
    sections: [
      {
        name: "Rhythm",
        chain: [
          { kind: "tuner", plugin: "VST: ReaTune (Cockos)", params: [], confidence: "confirmed" },
          { kind: "amp", plugin: "VST3: Archetype Nolly (Neural DSP)", params, confidence: "likely" },
        ],
      },
    ],
    sources: [],
    signature: ["Scooped high-gain rhythm"],
    match: { rating: "close", summary: "Same kind of amp." },
  });

describe("catalog", () => {
  it("drops host params and lists options or ranges for the model", () => {
    expect(catalog[1].params.map((p) => p.name)).toEqual(["Gate", "Amp Type", "Rhythm Gain"]);
    const prompt = catalogPrompt(catalog);
    expect(prompt).toContain("### VST3: Archetype Nolly (Neural DSP)\nModels: Modern rock/metal");
    expect(prompt).toContain("\nGate: -90.0 .. 0.0\nAmp Type: Clean | Crunch | Rhythm | Lead");
    expect(prompt).not.toContain("Wet:");
  });

  it("reads numbers the way plugins display them", () => {
    expect(parseDisplayNumber("1.2 kHz")).toBe(1200);
    expect(parseDisplayNumber("50 ms")).toBe(0.05);
    expect(parseDisplayNumber("+1.5 dB")).toBe(1.5);
    expect(parseDisplayNumber("-inf")).toBe(-1e9);
    expect(parseDisplayNumber("Rhythm")).toBeUndefined();
  });

  it("accepts a recipe that only uses real params and values", () => {
    const good = recipe([
      { name: "amp type", value: "lead" },
      { name: "Gate", value: "-60 dB" },
      { name: "Rhythm Gain", value: "0.7" },
    ]);
    expect(checkRecipe(good, catalog)).toEqual([]);
  });

  it("explains unknown plugins, params and out-of-range values", () => {
    const bad = recipe([
      { name: "Amp Type", value: "Plexi" },
      { name: "Gate", value: "-120" },
      { name: "Drive", value: "0.5" },
    ]);
    bad.sections[0].chain.push({ kind: "drive", plugin: "VST3: Fortin Grind", params: [], confidence: "guess", bypassed: false });
    const problems = checkRecipe(bad, catalog);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('"Amp Type" = "Plexi" must be one of Clean | Crunch | Rhythm | Lead');
    expect(problems[1]).toContain("must be from -90.0 to 0.0");
    expect(problems[2]).toContain('has no param "Drive"');
    expect(problems[3]).toContain('plugin "VST3: Fortin Grind" is not installed');
  });

  it("asks for a match rating, and for gaps and products when it is not close", () => {
    const noMatch = parseRecipe({ ...recipe([]), match: undefined, signature: undefined });
    expect(checkRecipe(noMatch, catalog).join("\n")).toMatch(/"match" is missing[\s\S]*"signature" is missing/);

    const partial = parseRecipe({ ...recipe([]), match: { rating: "partial", summary: "No chorus." } });
    expect(checkRecipe(partial, catalog)).toEqual([expect.stringContaining('"gaps" is empty')]);

    const vague = parseRecipe({ ...partial, gaps: [{ missing: "Boss CE-1", impact: "high", using: "TAL-Chorus-LX", get: [] }] });
    expect(checkRecipe(vague, catalog)).toEqual([expect.stringContaining('"Boss CE-1": name 1-3 products')]);

    const good = parseRecipe({ ...vague, gaps: [{ ...vague.gaps![0], get: ["Boss CE-1 capture (free) - the real circuit"] }] });
    expect(checkRecipe(good, catalog)).toEqual([]);
  });

  it("rejects unknown match ratings and gap impacts", () => {
    expect(() => parseRecipe({ ...recipe([]), match: { rating: "great", summary: "x" } })).toThrow("match.rating");
    expect(() => parseRecipe({ ...recipe([]), gaps: [{ missing: "x", impact: "huge", get: [] }] })).toThrow("gaps[0].impact");
  });

  it("puts display values into the script as strings", () => {
    const script = buildReaperScript(recipe([{ name: "Amp Type", value: "Lead" }]), { newProject: true, saveAs: "C:\\x\\a.rpp" });
    expect(script).toContain('{ name = "Amp Type", value = "Lead" }');
    expect(script).toContain('local SAVE_AS = "C:\\\\x\\\\a.rpp"');
  });
});

describe("extractJson", () => {
  it("finds the object inside prose or fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("no json")).toThrow("no JSON object");
  });
});


describe("researchTone", () => {
  const RIG = "https://example.com/rig";
  const facts = (sources: string[] = [RIG]) =>
    Object.fromEntries(["players", "guitars", "amps", "effects", "studio"].map((t) => [t, { finding: `${t} finding`, sources }]));
  const draft = (ampType: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      song: "Kill the King",
      artist: "Megadeth",
      tuning: "E A D G B E",
      facts: facts(),
      sections: [
        {
          name: "Rhythm",
          chain: [
            { kind: "tuner", plugin: "VST: ReaTune (Cockos)", params: [], confidence: "confirmed" },
            { kind: "amp", plugin: "VST3: Archetype Nolly (Neural DSP)", params: [{ name: "Amp Type", value: ampType }], confidence: "likely" },
          ],
        },
      ],
      sources: [RIG],
      signature: ["Dry Mesa-style rhythm"],
      match: { rating: "close", summary: "Close." },
      ...extra,
    });
  const text = (content: string, tokens = 100) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: tokens } });
  const tools = (...calls: [name: string, args: Record<string, string>][]) => ({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, function: { name, arguments: JSON.stringify(args) } })),
        },
      },
    ],
    usage: { total_tokens: 100 },
  });

  /** A fake Z.ai that plays back chat replies in order and returns one search hit. */
  function fakeZai(replies: unknown[]) {
    const calls: { path: ZaiPath; body: Record<string, unknown> }[] = [];
    const post = async (path: ZaiPath, body: unknown) => {
      calls.push({ path, body: body as Record<string, unknown> });
      if (path === "/web_search") return { search_result: [{ title: "Rig", link: RIG, content: "CAE 3+" }] };
      return replies.shift();
    };
    const userMessages = (i: number) =>
      (calls.filter((c) => c.path === "/chat/completions")[i].body.messages as { role: string; content: string }[]).filter((m) => m.role === "user");
    return { calls, post, userMessages };
  }

  it("searches, then fixes an invalid recipe before returning it", async () => {
    const zai = fakeZai([tools(["search_web", { query: "Mustaine rig 2000" }]), text(draft("JCM800"), 200), text(draft("Crunch"), 50)]);
    const steps: string[] = [];
    const trace = emptyTrace("", "");
    const result = await researchTone("Kill the King Megadeth", catalog, zai.post, { onStep: (s) => steps.push(s.kind), trace });

    expect(result.recipe.sections[0].chain[1].params[0].value).toBe("Crunch");
    expect(result.searches).toEqual(["Mustaine rig 2000"]);
    expect(result.tokens).toBe(350);
    expect(steps).toEqual(["search", "writing", "fixing"]);
    expect(zai.calls.map((c) => c.path)).toEqual(["/chat/completions", "/web_search", "/chat/completions", "/chat/completions"]);
    expect(zai.userMessages(2).at(-1)?.content).toContain('"Amp Type" = "JCM800" must be one of');
    expect(zai.calls[3].body.tools).toBeUndefined();
    // Without a page reader the model is not offered read_page.
    expect((zai.calls[0].body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["search_web"]);

    // The trace keeps what was searched and found, for checking the model later.
    expect(trace.query).toBe("Kill the King Megadeth");
    expect(trace.searches).toEqual([{ query: "Mustaine rig 2000", results: [{ title: "Rig", link: RIG, snippet: "CAE 3+" }] }]);
    expect(trace.replies).toHaveLength(2);
    expect(trace.problems).toEqual([[expect.stringContaining('"JCM800"')]]);
    expect(trace.tokens).toBe(350);
  });

  it("reads pages from its search results, and only those", async () => {
    const article = `<html><head><title>Mustaine interview</title></head><body><nav>Home News</nav><article><p>${"Dave Mustaine played a Dean VMNT through a Marshall JCM800 with a Tube Screamer. ".repeat(40)}</p></article><footer>Cookies</footer></body></html>`;
    const fetched: string[] = [];
    const zai = fakeZai([
      tools(["search_web", { query: "Mustaine rig" }]),
      tools(["read_page", { url: "https://www.example.com/rig/" }], ["read_page", { url: "https://evil.example/other" }]),
      text(draft("Crunch")),
    ]);
    const steps: string[] = [];
    const trace = emptyTrace("", "");
    await researchTone("Kill the King Megadeth", catalog, zai.post, {
      trace,
      onStep: (s) => steps.push(`${s.kind}:${s.text}`),
      readPage: async (url) => {
        fetched.push(url);
        return article;
      },
    });

    expect(fetched).toEqual([RIG]);
    expect(steps).toContain("reading:Rig");
    const toolReplies = (zai.calls[3].body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool").slice(-2);
    const page = JSON.parse(toolReplies[0].content) as { title: string; text: string };
    expect(page.title).toBe("Mustaine interview");
    expect(page.text).toContain("Marshall JCM800");
    expect(page.text).not.toContain("Cookies");
    expect(JSON.parse(toolReplies[1].content)).toEqual({ error: "read_page only opens links from your search results" });
    expect(trace.pages).toEqual([{ url: RIG, title: "Mustaine interview", chars: expect.any(Number) }]);
  });

  it("sends topics with no source back for more research, and drops invented URLs", async () => {
    const unsourced = draft("Crunch", { facts: { ...facts(), amps: { finding: "A Marshall", sources: ["https://made-up.example/amp"] } } });
    const zai = fakeZai([tools(["search_web", { query: "Mustaine rig" }]), text(unsourced), tools(["search_web", { query: "Mustaine amp 2000" }]), text(draft("Crunch"))]);
    const trace = emptyTrace("", "");
    const result = await researchTone("Kill the King Megadeth", catalog, zai.post, { trace });

    expect(result.searches).toEqual(["Mustaine rig", "Mustaine amp 2000"]);
    expect(trace.followUp).toEqual(["amps"]);
    expect(trace.dropped).toEqual(["https://made-up.example/amp"]);
    const followUp = zai.userMessages(2).at(-1)!.content;
    expect(followUp).toContain("No source backs these topics yet: amps");
    expect(followUp).toContain("were removed: https://made-up.example/amp");
    // The follow-up may search again, so tools stay on.
    expect(zai.calls.filter((c) => c.path === "/chat/completions")[2].body.tools).toBeDefined();
    expect(result.recipe.facts?.amps?.sources).toEqual([RIG]);
  });

  it("accepts 'Not documented' once searches run out, but not a missing topic", async () => {
    const thin = { ...facts(), studio: { finding: "Not documented", sources: [] } } as Record<string, unknown>;
    const missing = { ...thin };
    delete missing.players;
    const zai = fakeZai([tools(["search_web", { query: "q" }]), text(draft("Crunch", { facts: missing })), text(draft("Crunch", { facts: thin }))]);
    const trace = emptyTrace("", "");
    const result = await researchTone("Kill the King Megadeth", catalog, zai.post, { trace, maxSearches: 1 });

    expect(trace.followUp).toBeUndefined();
    expect(trace.problems).toEqual([[expect.stringContaining("facts.players is missing")]]);
    expect(result.recipe.facts?.studio).toEqual({ finding: "Not documented", sources: [] });
  });

  it("gives the model the player's notes and the previous recipe", async () => {
    const previous = parseRecipe({ ...JSON.parse(draft("Lead")), notes: ["old note"], recording: { id: "1", title: "Kill the King", artist: "Megadeth" } });
    const zai = fakeZai([text(draft("Crunch"))]);
    await researchTone("Kill the King Megadeth", catalog, zai.post, { notes: ["old note", "The rhythm is too fizzy"], previous, maxSearches: 0 });

    const first = zai.userMessages(0)[0].content;
    expect(first).toContain("- old note\n- The rhythm is too fizzy");
    expect(first).toContain("newest note last");
    expect(first).toContain('"value":"Lead"');
    expect(first).not.toContain('"notes"');
    expect(first).not.toContain('"recording"');
  });
});

describe("keepFoundSources", () => {
  it("keeps URLs it saw, however they are written, and drops the rest", () => {
    const r = parseRecipe({ ...recipe([]), sources: ["http://Example.com/rig/", "https://nope.example/x"] });
    const { recipe: kept, dropped } = keepFoundSources(r, new Set(["example.com/rig"]));
    expect(kept.sources).toEqual(["http://Example.com/rig/"]);
    expect(dropped).toEqual(["https://nope.example/x"]);
  });
});
