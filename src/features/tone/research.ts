// The tone researcher: GLM searches the web for the gear used on a song,
// reads the best pages in full, then writes a recipe that uses only the
// player's own plugins. The recipe is checked (every research topic answered,
// every source one it actually found, every param real) and sent back until
// it is valid, so whatever reaches REAPER names real params with real values.

import { catalogPrompt, checkRecipe, type CatalogPlugin } from "./catalog.ts";
import { htmlToText, pageExcerpt } from "./page-text.ts";
import { FACT_TOPICS, parseRecipe, RecipeError, type FactTopic, type ToneRecipe } from "./recipe.ts";

export type ZaiPath = "/chat/completions" | "/web_search";
/** Sends a request to the Z.ai API (the key lives with the caller). */
export type ZaiPost = (path: ZaiPath, body: unknown) => Promise<unknown>;

export interface ResearchStep {
  kind: "search" | "reading" | "writing" | "fixing";
  text: string;
}

/** Everything a run did, saved so its searches can be checked later. */
export interface ResearchTrace {
  model: string;
  query: string;
  searches: { query: string; results: { title: string; link: string; snippet: string }[]; error?: string }[];
  /** Pages read in full, with how much text the model got. */
  pages: { url: string; title: string; chars: number; error?: string }[];
  /** Topics the first draft had no source for, sent back to research more. */
  followUp?: FactTopic[];
  /** URLs the model cited that were not in its search results (removed). */
  dropped: string[];
  /** The player's corrections this run was asked to apply. */
  notes?: string[];
  /** The model's text replies in order (recipe drafts, fixes). */
  replies: string[];
  /** Validation problems sent back for fixing, per round. */
  problems: string[][];
  tokens: number;
}

export const emptyTrace = (model: string, query: string): ResearchTrace => ({
  model,
  query,
  searches: [],
  pages: [],
  dropped: [],
  replies: [],
  problems: [],
  tokens: 0,
});

export interface ResearchOptions {
  model?: string;
  /** Model turns allowed for searching and reading before it must write the recipe. */
  searchTurns?: number;
  /** Web searches allowed in total ($0.01 each); later calls are refused. */
  maxSearches?: number;
  /** Fetches a page's HTML; without it the model only sees search snippets. */
  readPage?: (url: string) => Promise<string>;
  /** Pages the model may read in full. */
  maxPages?: number;
  /** Rounds allowed for correcting an invalid recipe. */
  fixRounds?: number;
  /** Installed plugins outside the catalog that recipes may still use (e.g. ReaTune). */
  installedFx?: string[];
  /** The player's corrections to the previous recipe, oldest first. */
  notes?: string[];
  /** The recipe the notes are about. */
  previous?: ToneRecipe;
  onStep?: (step: ResearchStep) => void;
  signal?: AbortSignal;
  /** Filled in as the run goes, so it is complete even when the run fails. */
  trace?: ResearchTrace;
}

export interface ResearchResult {
  recipe: ToneRecipe;
  searches: string[];
  tokens: number;
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ChatReply {
  choices: { message: ChatMessage; finish_reason?: string }[];
  usage?: { total_tokens?: number };
}
interface SearchReply {
  search_result?: { title?: string; link?: string; content?: string }[];
}

export const DEFAULT_MODEL = "glm-5.3-flash";
const SEARCH_ENGINE = "search-prime";

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_web",
    description:
      "Search the web. Use it for rig rundowns, interviews, producer notes and gear sites about the song's recording.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
};

const READ_TOOL = {
  type: "function",
  function: {
    name: "read_page",
    description:
      "Read the full text of a page from your search results. Snippets are short and often cut off who played what or which pedal was used; read interviews and rig rundowns before trusting a detail.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "A link from your search results" } },
      required: ["url"],
    },
  },
};

const FACT_HINTS: Record<FactTopic, string> = {
  players: "who played which guitar part on the record",
  guitars: "the guitars and pickups used",
  amps: "the amps and cabinets",
  effects: "the pedals and effects, and which parts use them",
  studio: "studio details: producer or engineer notes, doubling, studio effects, and whether sources describe the record or a live rig",
};

const RECIPE_SHAPE = `{
  "song": "Song title", "artist": "Artist",
  "tuning": "low to high, e.g. E A D G B E or D A D F A E",
  "facts": {
${FACT_TOPICS.map((t) => `    "${t}": { "finding": "What the sources say about ${FACT_HINTS[t]}", "sources": ["URLs from your search results that say it"] }`).join(",\n")}
  },
  "signature": ["The 2-4 things a listener recognises, e.g. 'Boss CE-1 chorus on clean Rickenbacker chords'"],
  "sections": [
    {
      "name": "Verse rhythm",
      "playing": "Who plays it on the record and on what guitar, then Pacifica pickup and knob advice, picking/palm-mute notes",
      "chain": [
        {
          "kind": "tuner|gate|comp|drive|amp|cab|eq|mod|delay|reverb|other",
          "plugin": "exact plugin name from the list, e.g. VST3: Archetype John Mayer X (Neural DSP)",
          "emulates": "original gear this block stands in for",
          "confidence": "confirmed|likely|guess",
          "params": [ { "name": "exact param name", "value": "display value as text" } ]
        }
      ]
    }
  ],
  "match": { "rating": "close|partial|far", "summary": "One or two sentences: how near this gets to the record with the player's plugins and guitar, and the biggest difference" },
  "gaps": [
    {
      "missing": "Original gear the player has no real equivalent for, e.g. 'Boss CE-1 Chorus Ensemble'",
      "impact": "high|medium|low",
      "using": "What the recipe uses instead, e.g. 'TAL-Chorus-LX mode I, slower and less bright'",
      "get": ["Product (free|paid, rough price) - why it is closer"]
    }
  ],
  "sources": ["URLs from your search results"]
}`;

function systemPrompt(catalog: CatalogPlugin[], installedFx: string[], limits: { searches: number; pages: number }): string {
  const extra = installedFx.filter((fx) => !catalog.some((p) => p.fx === fx));
  const reading =
    limits.pages > 0
      ? ` Search results show only a short snippet: use read_page (at most ${limits.pages} pages) to read the best interviews and rig rundowns in full before relying on a detail, especially who played which part.`
      : "";
  return `You are a guitar tone researcher. A player wants to practise along with a recording in REAPER. Sound matters to them: the tone must be recognisably the record's, and where their plugins cannot get there they want to be told exactly what to get.

The player: Yamaha Pacifica 012 (HSS: single coils at neck and middle, humbucker at bridge), Focusrite Scarlett interface, headphones.

How to work:
1. Research this specific recording. Find out each of these, because every one changes the sound:
${FACT_TOPICS.map((t) => `   - ${t}: ${FACT_HINTS[t]}`).join("\n")}
   Use search_web with focused queries (for example "<song> <artist> guitar rig", "<guitarist> interview <song> pedal", "<song> rig rundown"), and run related searches together in one turn. You have at most ${limits.searches} searches.${reading}
   Prefer interviews with the players, producer or engineer, then rig rundowns (Premier Guitar, Guitar World, Sound on Sound, Mix, Guitar.com), then gear-list sites (Equipboard, Ground Guitar), then forums. Sources often disagree: prefer the first-hand account and say in "playing" or "emulates" when a fact is disputed.
   The player picked one exact recording: research that artist's version, not covers or other songs with the same title. Studio gear often differs from the live rig; use the studio recording's gear when sources separate them. The plugin notes below already say what the player's amp models are, so do not spend searches on that.
2. Write "facts": for each topic, what the sources say and the URLs that say it. Cite only URLs that appeared in your search results; others are removed. If a topic is not documented after searching, write "Not documented" with no sources, and mark the blocks that depend on it "guess".
3. Write "signature": the 2 to 4 things that make this guitar sound recognisable. Often these are effects (chorus, flanger, delay, reverb, wah, octave, fuzz) as much as the amp. Every signature element must appear in the chains. Never drop one because the exact unit is missing: use the nearest plugin the player owns and record it in "gaps".
4. Decide the distinct guitar sounds in the song (for example "Intro clean", "Verse rhythm", "Solo"). Merge parts that share a sound. Usually 1 to 4 sections.
5. Build each section's chain from the plugins listed below, in real signal order (drive and modulation pedals before the amp, delay and reverb after it, unless the record did otherwise):
   - Start every chain with ReaTune ("VST: ReaTune (Cockos)", kind "tuner", no params) so the player can check the tuning.
   - Choose the amp by what it models (each plugin's "Models" note), not by its channel name. A vintage Fender, Mesa or Marshall clean is not a modern hi-fi clean, and a modern high-gain channel is not a vintage lead channel.
   - Amp-sim plugins hold pedals, amp, cab and effects in one: switch blocks on with their Active params and set amp and cab types that match. Use two amp-sim plugins in one chain only when one has its amp and cab switched off and is there for its pedals or effects.
   - Match gain staging to the record: many classic sounds are a clean amp with a pedal doing the dirt. Keep gain lower than you think; headphones and a humbucker add gain.
   - Allow for the Pacifica: for a single-coil record use the neck or middle single coil where it suits, or tame the humbucker with EQ; for a humbucker record use the bridge humbucker.
   - NeuralAmpModeler and Gateway need a capture file the player has to load, so do not put them in chains; recommend specific captures in "gaps".
6. Params: use param names exactly as listed. Write every value as a string the way the plugin displays it: one of the listed options for switches and menus, or a number inside the listed range for knobs (units optional, e.g. "-6.0", "1.2 kHz", "0.65"). Set the amp type, gain, tone stack and every block you switch on; leave the rest at default.
7. "playing": who plays the part on the record and on what, then which Pacifica pickup, guitar volume and tone, and how to pick.
8. "confidence" per block: "confirmed" when a source names that gear for this recording, "likely" for gear from the same era or tour, "guess" for an approximation by ear.
9. "match": be honest. "close" only if every signature element is covered by a plugin that models the same kind of circuit; "partial" if the character is there but a signature element is a rough stand-in; "far" if the core sound (amp type, fuzz, a key effect) cannot really be made with the player's plugins.
10. "gaps": one entry for each important piece of original gear the player's plugins only approximate (amp, drive, modulation, delay, reverb, guitar or pickup), most important first. In "get", name 1 to 3 specific products that would get closer: free ones first (free NAM captures or IRs from tone3000.com, free pedal plugins), then paid ones with a rough price. Never recommend something already in the player's list. Leave "gaps" empty only when the match is close.
11. "sources": the URLs from your search results that back the recipe. Never invent URLs.

When you have researched enough, reply with ONLY one JSON object (no prose, no code fences) shaped like:
${RECIPE_SHAPE}

The player's plugins, what they model, and their params (name: options, or min .. max):

${catalogPrompt(catalog)}${extra.length ? `\n\nAlso installed (params unknown, use without params): ${extra.join(", ")}` : ""}`;
}

/** The first message: the song, plus the player's corrections when there are any. */
function userPrompt(query: string, notes: string[], previous?: ToneRecipe): string {
  if (!notes.length) return `Song: ${query}`;
  let prior = "";
  if (previous) {
    const copy: Partial<ToneRecipe> = { ...previous };
    delete copy.notes;
    delete copy.recording;
    prior = `\n\nThe previous recipe:\n${JSON.stringify(copy)}`;
  }
  return `Song: ${query}

The player tried the previous recipe for this song and says it is wrong${notes.length > 1 ? " (newest note last)" : ""}:
- ${notes.join("\n- ")}

Treat the player's notes as facts about the record unless a source clearly shows otherwise; if one does, say so in "match.summary". Research what the notes change, fix every fact, section, block, signature item and gap they affect, and keep what they do not touch.${prior}`;
}

/** "https://www.Site.com/a/" and "site.com/a" are the same page. */
export const urlKey = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");

/** Removes cited URLs the model never saw, so every source is one it found. */
export function keepFoundSources(recipe: ToneRecipe, seen: Set<string>): { recipe: ToneRecipe; dropped: string[] } {
  const dropped: string[] = [];
  const keep = (urls: string[]) =>
    urls.filter((url) => {
      if (seen.has(urlKey(url))) return true;
      if (!dropped.includes(url)) dropped.push(url);
      return false;
    });
  const facts = recipe.facts
    ? Object.fromEntries(Object.entries(recipe.facts).map(([topic, fact]) => [topic, { ...fact, sources: keep(fact.sources) }]))
    : undefined;
  return { recipe: { ...recipe, sources: keep(recipe.sources), ...(facts && { facts }) }, dropped };
}

/** Research topics with no source behind them yet. */
export const unsourcedTopics = (recipe: ToneRecipe): FactTopic[] =>
  FACT_TOPICS.filter((t) => !recipe.facts?.[t]?.sources.length);

/** The checklist: every topic must be answered, even if only "Not documented". */
export function checkFacts(recipe: ToneRecipe): string[] {
  if (!recipe.facts) return [`"facts" is missing: say what the sources found about ${FACT_TOPICS.join(", ")}, with their URLs`];
  return FACT_TOPICS.filter((t) => !recipe.facts?.[t]).map(
    (t) => `facts.${t} is missing: say what the sources found about ${FACT_HINTS[t]}, or "Not documented"`,
  );
}

/** Pulls the JSON object out of a reply that may be wrapped in prose or fences. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new RecipeError("reply contains no JSON object");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new RecipeError(`reply is not valid JSON (${(error as Error).message})`);
  }
}

export async function researchTone(
  query: string,
  catalog: CatalogPlugin[],
  post: ZaiPost,
  options: ResearchOptions = {},
): Promise<ResearchResult> {
  const { model = DEFAULT_MODEL, searchTurns = 8, maxSearches = 10, fixRounds = 2, installedFx = [], onStep, signal, readPage, notes = [], previous } = options;
  const maxPages = readPage ? (options.maxPages ?? 5) : 0;
  const trace = options.trace ?? emptyTrace(model, query);
  Object.assign(trace, { model, query }, notes.length ? { notes } : {});
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(catalog, installedFx, { searches: maxSearches, pages: maxPages }) },
    { role: "user", content: userPrompt(query, notes, previous) },
  ];
  const tools = maxPages > 0 ? [SEARCH_TOOL, READ_TOOL] : [SEARCH_TOOL];
  const searches: string[] = [];
  /** Every link the searches returned, by urlKey, so citations and page reads can be checked. */
  const seen = new Map<string, { link: string; title: string }>();
  // A fix starts from a recipe whose sources an earlier run found, so they stay citable and readable.
  for (const url of [...(previous?.sources ?? []), ...Object.values(previous?.facts ?? {}).flatMap((f) => f.sources)]) {
    if (!seen.has(urlKey(url))) seen.set(urlKey(url), { link: url, title: "" });
  }
  const read = new Set<string>();
  const keywords = query.split(/[^\p{L}\p{N}']+/u);
  let tokens = 0;

  const chat = async (withTools: boolean) => {
    signal?.throwIfAborted();
    const reply = (await post("/chat/completions", {
      model,
      messages,
      ...(withTools ? { tools, tool_choice: "auto" } : {}),
      max_tokens: 16000,
    })) as ChatReply;
    tokens += reply.usage?.total_tokens ?? 0;
    trace.tokens = tokens;
    const message = reply.choices?.[0]?.message;
    if (!message) throw new Error("Z.ai returned no message");
    if (message.content?.trim()) trace.replies.push(message.content);
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });
    return message;
  };

  const args = (call: ToolCall): Record<string, unknown> => {
    try {
      return JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const search = async (call: ToolCall) => {
    const q = String(args(call).query ?? "").trim();
    if (!q) return JSON.stringify({ error: "search_web needs a query string" });
    if (searches.length >= maxSearches) {
      return JSON.stringify({ error: "search limit reached: write the recipe from what you have found" });
    }
    searches.push(q);
    onStep?.({ kind: "search", text: q });
    signal?.throwIfAborted();
    try {
      const reply = (await post("/web_search", { search_engine: SEARCH_ENGINE, search_query: q, count: 6 })) as SearchReply;
      const hits = (reply.search_result ?? []).map((h) => ({
        title: h.title ?? "",
        link: h.link ?? "",
        content: (h.content ?? "").slice(0, 1500),
      }));
      for (const hit of hits) if (hit.link) seen.set(urlKey(hit.link), { link: hit.link, title: hit.title });
      trace.searches.push({ query: q, results: hits.map((h) => ({ title: h.title, link: h.link, snippet: h.content.slice(0, 400) })) });
      return JSON.stringify(hits);
    } catch (error) {
      trace.searches.push({ query: q, results: [], error: (error as Error).message });
      return JSON.stringify({ error: `search failed: ${(error as Error).message}` });
    }
  };

  const readTool = async (call: ToolCall) => {
    const key = urlKey(String(args(call).url ?? ""));
    const hit = seen.get(key);
    if (!readPage || !hit) return JSON.stringify({ error: "read_page only opens links from your search results" });
    if (read.has(key)) return JSON.stringify({ error: "you already read this page; its text is above" });
    if (read.size >= maxPages) return JSON.stringify({ error: "page limit reached: write the recipe from what you have found" });
    read.add(key);
    onStep?.({ kind: "reading", text: hit.title || hit.link });
    signal?.throwIfAborted();
    try {
      const page = htmlToText(await readPage(hit.link));
      const text = pageExcerpt(page.text, keywords);
      const title = page.title || hit.title;
      if (text.length < 300) {
        trace.pages.push({ url: hit.link, title, chars: text.length, error: "no readable text" });
        return JSON.stringify({ error: "the page has no readable text (it may need JavaScript); rely on its snippet or read another" });
      }
      trace.pages.push({ url: hit.link, title, chars: text.length });
      return JSON.stringify({ url: hit.link, title, text });
    } catch (error) {
      trace.pages.push({ url: hit.link, title: hit.title, chars: 0, error: (error as Error).message });
      return JSON.stringify({ error: `could not read the page: ${(error as Error).message}` });
    }
  };

  /** Lets the model search and read until it replies with text, and returns that reply. */
  const investigate = async (turns: number) => {
    let message = await chat(true);
    for (let turn = 1; message.tool_calls?.length && turn < turns; turn++) {
      for (const call of message.tool_calls) {
        const content = call.function.name === "read_page" ? await readTool(call) : await search(call);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      message = await chat(true);
    }
    if (message.tool_calls?.length) {
      // Out of turns: answer the pending calls and ask for the recipe.
      for (const call of message.tool_calls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "research limit reached" }) });
      }
      messages.push({ role: "user", content: "Stop researching now and reply with the recipe JSON only." });
      onStep?.({ kind: "writing", text: "Writing the recipe" });
      return chat(false);
    }
    onStep?.({ kind: "writing", text: "Writing the recipe" });
    return message;
  };

  let message = await investigate(searchTurns);
  let followedUp = false;
  // Validate, and send problems back until the recipe is clean.
  for (let fixes = 0; ; ) {
    let problems: string[];
    try {
      const found = keepFoundSources(parseRecipe(extractJson(message.content ?? "")), new Set(seen.keys()));
      for (const url of found.dropped) if (!trace.dropped.includes(url)) trace.dropped.push(url);
      const recipe = found.recipe;
      const missing = unsourcedTopics(recipe);
      // The checklist: one more round of research for topics with no source, while searches remain.
      if (!followedUp && missing.length > 0 && searches.length < maxSearches) {
        followedUp = true;
        trace.followUp = missing;
        const removed = found.dropped.length
          ? ` These URLs were not in your search results and were removed: ${found.dropped.join(", ")}.`
          : "";
        const pagesLeft = maxPages - read.size;
        messages.push({
          role: "user",
          content: `No source backs these topics yet: ${missing.map((t) => `${t} (${FACT_HINTS[t]})`).join("; ")}.${removed} Research them now (${maxSearches - searches.length} searches left${pagesLeft > 0 ? `, ${pagesLeft} page reads` : ""}), then reply with the whole recipe JSON, updated with what you found. If a topic really is not documented, write "Not documented" for it.`,
        });
        message = await investigate(4);
        continue;
      }
      problems = [...checkFacts(recipe), ...checkRecipe(recipe, catalog, installedFx)];
      if (problems.length === 0) return { recipe, searches, tokens };
    } catch (error) {
      if (!(error instanceof RecipeError)) throw error;
      problems = [error.message];
    }
    trace.problems.push(problems);
    if (fixes >= fixRounds) {
      throw new Error(`The recipe still has problems after ${fixRounds} fixes:\n- ${problems.slice(0, 8).join("\n- ")}`);
    }
    fixes++;
    onStep?.({ kind: "fixing", text: `Fixing ${problems.length} problem${problems.length === 1 ? "" : "s"}` });
    messages.push({
      role: "user",
      content: `The recipe has these problems:\n- ${problems.slice(0, 30).join("\n- ")}\n\nReply with the whole corrected recipe JSON only.`,
    });
    message = await chat(false);
  }
}
