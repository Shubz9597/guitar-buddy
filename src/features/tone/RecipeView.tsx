import { useState } from "react";
import type { ToneBridge } from "./bridge.ts";
import { paramKey } from "./catalog.ts";
import { describeSource, groupParams, isOn, isOnOff, parseTuning, splitPartName, splitSentences, splitSuggestion } from "./present.ts";
import type { Confidence, FxBlock, ToneRecipe } from "./recipe.ts";
import { FactsCard, FixBox, MatchCard, ResearchLogCard } from "./Fidelity.tsx";
import { Knob } from "./Knob.tsx";
import { ChevronIcon, ExternalIcon, PickIcon } from "./tone-icons.tsx";

export type Action = "add" | "tab" | "rpp" | "script";

export interface RunResult {
  action: Action;
  report?: string;
  message: string;
  warnings: number;
}

/** "VST3: Archetype Nolly (Neural DSP)" -> "Archetype Nolly" */
export const shortPlugin = (fx: string) => fx.replace(/^\w+:\s*/, "").replace(/\s*\([^()]*\)$/, "");

const CONFIDENCE: Record<Confidence, { label: string; title: string }> = {
  confirmed: { label: "Confirmed", title: "A source names this gear for this recording" },
  likely: { label: "Likely", title: "Gear from the same era or tour" },
  guess: { label: "Approximation", title: "Chosen by ear to get the sound close" },
};

const KIND_LABEL: Record<FxBlock["kind"], string> = {
  tuner: "Tuner",
  gate: "Gate",
  comp: "Compressor",
  drive: "Drive",
  amp: "Amp",
  cab: "Cabinet",
  eq: "EQ",
  mod: "Modulation",
  delay: "Delay",
  reverb: "Reverb",
  other: "Effect",
};

export function RecipeView({
  recipe,
  busy,
  run,
  canRun,
  onAction,
  bridge,
  switches,
  knobs,
  units,
  savedId,
  canFix,
  fixing,
  onFix,
  onShowFix,
}: {
  /** The saved file, for finding its research log. */
  savedId?: string;
  /** Whether a new research run can start (key and plugins ready). */
  canFix: boolean;
  /** A fix for this tone is running now. */
  fixing: boolean;
  /** Researches the tone again with the player's note. */
  onFix: (note: string) => void;
  onShowFix: () => void;
  recipe: ToneRecipe;
  busy?: Action;
  run?: RunResult;
  canRun: boolean;
  onAction: (action: Action) => void;
  bridge: ToneBridge;
  /** On/off params shown as 0/1, from catalog binarySwitches(). */
  switches: Set<string>;
  /** 0..1 knobs shown on a 0-10 scale, from catalog unitKnobs(). */
  knobs: Set<string>;
  /** Units the plugin's display leaves out, from catalog paramUnits(). */
  units: Map<string, string>;
}) {
  const [sectionIndex, setSectionIndex] = useState(0);
  const section = recipe.sections[Math.min(sectionIndex, recipe.sections.length - 1)];
  const tuning = parseTuning(recipe.tuning);
  const disabled = busy !== undefined;
  const reaperTitle = canRun ? undefined : "REAPER was not found";
  // Older recipes have free-text suggestions; newer ones list them per gap in the match card.
  const showSuggestions = !recipe.gaps?.length && (recipe.suggestions?.length ?? 0) > 0;

  return (
    <article className="recipe" aria-label={`Tone for ${recipe.song}`}>
      <header className="card recipe-hero">
        <div className="recipe-hero__song">
          <h2 className="recipe-hero__title">{recipe.song}</h2>
          <p className="recipe-hero__artist">{recipe.artist}</p>
        </div>
        {tuning && (
          <div className="tuning" aria-label={`Tuning: ${recipe.tuning}`}>
            <span className="tuning__name">
              {tuning.strings ? `${tuning.name} tuning` : tuning.name}
              {tuning.strings?.some((s) => s.changed) && <span className="tone-muted">Orange strings differ from standard</span>}
            </span>
            {tuning.strings && (
              <ol className="tuning__strings">
                {tuning.strings.map((s, i) => (
                  <li key={i} data-changed={s.changed} title={s.changed ? "Retune this string" : undefined}>
                    {s.note}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        <div className="recipe-hero__actions">
          <button type="button" className="button button--primary" disabled={disabled || !canRun} title={reaperTitle ?? "Adds one track per part to the project open in REAPER"} onClick={() => onAction("add")}>
            {busy === "add" ? "Adding…" : "Add to open project"}
          </button>
          <button type="button" className="button" disabled={disabled || !canRun} title={reaperTitle ?? "Builds the tracks in a new REAPER project tab"} onClick={() => onAction("tab")}>
            {busy === "tab" ? "Opening…" : "New REAPER tab"}
          </button>
          <button type="button" className="button" disabled={disabled || !canRun} title={reaperTitle ?? "Builds in a new tab and saves an .rpp file"} onClick={() => onAction("rpp")}>
            {busy === "rpp" ? "Saving…" : "Save as project…"}
          </button>
          <button type="button" className="button" disabled={disabled} title="Saves a script you can run on any project later" onClick={() => onAction("script")}>
            Save script…
          </button>
        </div>
        {run && (
          <div className="run-result" data-ok={run.warnings === 0} role="status">
            <p>
              {run.message}
              {run.warnings > 0 && run.report && ` ${run.warnings} setting${run.warnings === 1 ? "" : "s"} could not be applied.`}
            </p>
            {run.report && (
              <details>
                <summary>See what REAPER set</summary>
                <pre className="tone-pre">{run.report}</pre>
              </details>
            )}
          </div>
        )}
      </header>

      <MatchCard recipe={recipe} />
      <FixBox notes={recipe.notes ?? []} canFix={canFix} fixing={fixing} onFix={onFix} onShowFix={onShowFix} />

      {recipe.sections.length > 1 && (
        <div className="parts" role="tablist" aria-label="Parts of the song">
          {recipe.sections.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              id={`part-${i}`}
              aria-selected={s === section}
              aria-controls="part-panel"
              className="parts__tab"
              onClick={() => setSectionIndex(i)}
            >
              {splitPartName(s.name).title}
            </button>
          ))}
        </div>
      )}

      <section className="card part" id="part-panel" role={recipe.sections.length > 1 ? "tabpanel" : undefined} aria-labelledby={recipe.sections.length > 1 ? `part-${recipe.sections.indexOf(section)}` : undefined}>
        <div className="part__head">
          {recipe.sections.length === 1 && <h3 className="part__title">{splitPartName(section.name).title}</h3>}
          {splitPartName(section.name).detail && <p className="part__detail">Used for the {splitPartName(section.name).detail}</p>}
        </div>
        {section.playing && (
          <div className="playing">
            <h4 className="playing__title">
              <PickIcon className="playing__icon" />
              How to play it
            </h4>
            <ul>
              {splitSentences(section.playing).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <ol className="chain-strip" aria-label="Signal chain">
          {section.chain.map((block, i) => (
            <li key={i}>
              {i > 0 && <ChevronIcon className="chain-strip__arrow" />}
              <a href={`#block-${i}`} className="chain-strip__item" data-bypassed={block.bypassed} title="Jump to its settings">
                <span className="chain-strip__kind">{KIND_LABEL[block.kind]}</span>
                <span className="chain-strip__name">{shortPlugin(block.plugin)}</span>
              </a>
            </li>
          ))}
        </ol>
        <ol className="blocks">
          {section.chain.map((block, i) => (
            <Block key={`${section.name}-${i}`} id={`block-${i}`} block={block} switches={switches} knobs={knobs} units={units} />
          ))}
        </ol>
      </section>

      {(showSuggestions || recipe.sources.length > 0 || savedId || recipe.facts) && (
        <div className="recipe-extras">
          {recipe.facts && <FactsCard facts={recipe.facts} bridge={bridge} />}
          {showSuggestions && (
            <section className="card extras">
              <h3 className="extras__title">To get closer</h3>
              <p className="tone-muted extras__intro">Not installed. Worth a look if this tone matters to you.</p>
              <ul className="suggestions">
                {recipe.suggestions?.map((text) => {
                  const { product, reason } = splitSuggestion(text);
                  return (
                    <li key={text}>
                      {product && <strong>{product}</strong>}
                      <span>{reason}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {recipe.sources.length > 0 && (
            <section className="card extras">
              <h3 className="extras__title">Sources</h3>
              <ul className="sources">
                {recipe.sources.map((url) => {
                  const { site, page } = describeSource(url);
                  return (
                    <li key={url}>
                      <button type="button" className="source" title={url} onClick={() => void bridge.openExternal(url)}>
                        <span className="source__site">{site}</span>
                        {page && <span className="source__page">{page}</span>}
                        <ExternalIcon className="source__icon" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {savedId && <ResearchLogCard savedId={savedId} bridge={bridge} />}
        </div>
      )}
    </article>
  );
}

function Block({
  block,
  id,
  switches,
  knobs,
  units,
}: {
  block: FxBlock;
  id: string;
  switches: Set<string>;
  knobs: Set<string>;
  units: Map<string, string>;
}) {
  const has = (set: Set<string>) => (name: string) => set.has(`${block.plugin}|${paramKey(name)}`);
  const unitOf = (name: string) => units.get(`${block.plugin}|${paramKey(name)}`);
  const groups = groupParams(block.params, { isSwitch: has(switches), isKnob: has(knobs), unitOf });
  const usesKnobScale = block.params.some((p) => has(knobs)(p.name));
  const named = groups.some((g) => g.name);
  const confidence = CONFIDENCE[block.confidence];
  return (
    <li className="block" id={id} data-bypassed={block.bypassed}>
      <div className="block__head">
        <span className="block__kind">{KIND_LABEL[block.kind]}</span>
        <strong className="block__name">{shortPlugin(block.plugin)}</strong>
        {block.bypassed && <span className="block__off">Bypassed</span>}
        <span className="confidence" data-level={block.confidence} title={confidence.title}>
          {confidence.label}
        </span>
      </div>
      {block.emulates && <p className="block__emulates">{block.emulates}</p>}
      {usesKnobScale && <p className="block__scale">Tone knobs are shown 0 to 10, as on the amp.</p>}
      {groups.length > 0 && (
        <div className="modules">
          {groups.map((group) => (
            <div key={group.name || "main"} className="module" data-enabled={group.enabled}>
              {(
                <div className="module__name">
                  <span>{group.name || (named ? "General" : "Settings")}</span>
                  {group.enabled !== undefined && (
                    <span className="pill" data-on={group.enabled}>
                      {group.enabled ? "On" : "Off"}
                    </span>
                  )}
                </div>
              )}
              <div className="module__body">
              {group.params.some((p) => p.knob !== undefined) && (
                <div className="knobs">
                  {group.params
                    .filter((p) => p.knob !== undefined)
                    .map((p) => (
                      <Knob key={p.label} label={p.label} value={p.knob!} />
                    ))}
                </div>
              )}
              {group.params.some((p) => p.knob === undefined) && (
                <dl className="module__params">
                  {group.params.filter((p) => p.knob === undefined).map((p) => (
                    <div key={p.label}>
                      <dt>{p.label}</dt>
                      <dd>
                        {isOnOff(p.value) ? (
                          <span className="pill" data-on={isOn(p.value)}>
                            {isOn(p.value) ? "On" : "Off"}
                          </span>
                        ) : (
                          p.value
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              </div>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
