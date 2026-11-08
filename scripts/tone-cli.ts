// Tone tools from the command line (the app's Tone screen uses the same code).
//
//   node --experimental-strip-types scripts/tone-cli.ts plugins
//   node --experimental-strip-types scripts/tone-cli.ts probe
//   node --experimental-strip-types scripts/tone-cli.ts build recipes/x.json [--new]
//   node --env-file=.env --experimental-strip-types scripts/tone-cli.ts research "Kill the King Megadeth"
//
// Scripts are written to REAPER's Scripts/GuitarBuddy folder; load them via
// Actions > Show action list > New action > Load ReaScript, or run them in the
// open REAPER with: reaper.exe -nonewinst "<script>.lua"

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProbe } from "../src/features/tone/catalog.ts";
import { findPlugin, parsePluginIni, PROBE_LIST } from "../src/features/tone/plugins.ts";
import { parseRecipe, type ToneRecipe } from "../src/features/tone/recipe.ts";
import { buildParamProbeScript, buildReaperScript, REPORT_DIR } from "../src/features/tone/reaper-script.ts";
import { researchTone, type ZaiPost } from "../src/features/tone/research.ts";

const reaperDir = join(process.env.APPDATA ?? "", "REAPER");
const scriptDir = join(reaperDir, REPORT_DIR);

function installed() {
  return parsePluginIni(readFileSync(join(reaperDir, "reaper-vstplugins64.ini"), "utf8"));
}

function save(fileName: string, content: string) {
  mkdirSync(scriptDir, { recursive: true });
  const path = join(scriptDir, fileName);
  writeFileSync(path, content);
  console.log(`Wrote ${path}`);
}

const slug = (r: ToneRecipe) => `${r.artist} - ${r.song}`.replace(/[^\w\- ]+/g, "").trim();

const zaiPost: ZaiPost = async (path, body) => {
  const key = process.env.ZAI_API_KEY;
  if (!key) throw new Error("ZAI_API_KEY is empty: put your key in .env");
  const response = await fetch(`https://api.z.ai/api/paas/v4${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Z.ai ${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "plugins":
    for (const p of installed().filter((p) => !p.instrument)) console.log(p.fxName);
    break;
  case "probe": {
    const plugins = installed();
    const names = PROBE_LIST.flatMap((q) => findPlugin(plugins, q)?.fxName ?? []);
    console.log(`Probing ${names.length} plugins:\n  ${names.join("\n  ")}`);
    save("Guitar Buddy - probe params.lua", buildParamProbeScript(names));
    break;
  }
  case "build": {
    const [file] = args.filter((a) => !a.startsWith("--"));
    if (!file) throw new Error("usage: build <recipe.json> [--new]");
    const recipe = parseRecipe(JSON.parse(readFileSync(file, "utf8")));
    save(`Guitar Buddy - ${slug(recipe)}.lua`, buildReaperScript(recipe, { newProject: args.includes("--new") }));
    break;
  }
  case "research": {
    const query = args.filter((a) => !a.startsWith("--")).join(" ");
    if (!query) throw new Error('usage: research "Song Artist"');
    const probe = join(scriptDir, "param-probe.json");
    if (!existsSync(probe)) throw new Error("No param-probe.json yet: run the probe script in REAPER first");
    const catalog = parseProbe(readFileSync(probe, "utf8"));
    const started = Date.now();
    const result = await researchTone(query, catalog, zaiPost, {
      model: process.env.ZAI_MODEL,
      onStep: (step) => console.log(`  [${step.kind}] ${step.text}`),
    });
    mkdirSync("recipes", { recursive: true });
    const file = join("recipes", `${slug(result.recipe)}.json`);
    writeFileSync(file, JSON.stringify(result.recipe, null, 2) + "\n");
    console.log(`Wrote ${file} (${result.searches.length} searches, ${result.tokens} tokens, ${Math.round((Date.now() - started) / 1000)} s)`);
    save(`Guitar Buddy - ${slug(result.recipe)}.lua`, buildReaperScript(result.recipe, { newProject: true }));
    break;
  }
  default:
    console.log('commands: plugins | probe | build <recipe.json> [--new] | research "Song Artist"');
}
