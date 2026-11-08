import { useEffect, useId, useState, type FormEvent } from "react";
import type { ToneBridge } from "./bridge.ts";
import { describeSource, splitSuggestion } from "./present.ts";
import { FACT_TOPICS, type FactTopic, type Gap, type MatchRating, type ToneRecipe } from "./recipe.ts";
import type { ResearchTrace } from "./research.ts";
import { ExternalIcon } from "./tone-icons.tsx";

const RATING: Record<MatchRating, { label: string; hint: string }> = {
  close: { label: "Close to the record", hint: "Your plugins cover every part of this sound." },
  partial: { label: "Partly there", hint: "The character is there, but some of the sound is a stand-in." },
  far: { label: "Rough approximation", hint: "The core of this sound needs gear you don't have yet." },
};

const IMPACT: Record<Gap["impact"], string> = { high: "Big difference", medium: "Noticeable", low: "Subtle" };

/**
 * How near the recipe gets to the record, what makes the sound, and what to
 * get for each part the player's plugins only approximate.
 */
export function MatchCard({ recipe }: { recipe: ToneRecipe }) {
  const { match, signature = [], gaps = [] } = recipe;
  if (!match) return null;
  const rating = RATING[match.rating];
  return (
    <section className="card match" data-rating={match.rating} aria-label="How close this gets">
      <div className="match__head">
        <span className="match__rating" data-rating={match.rating}>
          {rating.label}
        </span>
        <p className="match__summary">{match.summary}</p>
      </div>

      {signature.length > 0 && (
        <div className="match__signature">
          <h3 className="match__label">What makes this sound</h3>
          <ul>
            {signature.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {gaps.length > 0 && (
        <div className="match__gaps">
          <h3 className="match__label">To get closer</h3>
          <ol className="gaps">
            {gaps.map((gap) => (
              <li key={gap.missing} className="gap" data-impact={gap.impact}>
                <div className="gap__head">
                  <strong>{gap.missing}</strong>
                  <span className="gap__impact" data-impact={gap.impact}>
                    {IMPACT[gap.impact]}
                  </span>
                </div>
                {gap.using && <p className="gap__using">For now: {gap.using}</p>}
                {gap.get.length > 0 && (
                  <ul className="gap__get">
                    {gap.get.map((text) => {
                      const { product, reason } = splitSuggestion(text);
                      const free = /\bfree\b/i.test(product ?? text);
                      return (
                        <li key={text}>
                          {product && <strong>{product}</strong>}
                          {free && <span className="gap__free">Free</span>}
                          <span className="gap__why">{reason}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {gaps.length === 0 && <p className="tone-muted">{rating.hint}</p>}
    </section>
  );
}

/**
 * Lets the player say what sounds wrong or what they know about the record,
 * and researches the tone again with it. Earlier notes are kept and sent too.
 */
export function FixBox({
  notes,
  canFix,
  fixing,
  onFix,
  onShowFix,
}: {
  notes: string[];
  canFix: boolean;
  fixing: boolean;
  onFix: (note: string) => void;
  onShowFix: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim() || !canFix) return;
    onFix(note.trim());
    setNote("");
    setOpen(false);
  };

  return (
    <section className="card fix" aria-label="Fix this tone">
      {notes.length > 0 && (
        <div className="fix__notes">
          <h3 className="match__label">Your corrections</h3>
          <ul>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {fixing ? (
        <div className="fix__row">
          <span className="fix__status">
            <span className="library__status" data-state="running" aria-hidden="true" />
            Researching again with your note…
          </span>
          <button type="button" className="button button--ghost" onClick={onShowFix}>
            Show progress
          </button>
        </div>
      ) : open ? (
        <form className="fix__form" onSubmit={submit}>
          <label htmlFor={id} className="fix__label">
            What's wrong, or what do you know about the record?
          </label>
          <textarea
            id={id}
            className="fix__input"
            rows={3}
            autoFocus
            value={note}
            placeholder="e.g. The intro is Wendy Melvoin on a Rickenbacker with a Boss CE-1 chorus. The solo is too fizzy."
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
            }}
          />
          <div className="fix__row">
            <span className="tone-muted">Researches the tone again and replaces this one. About $0.10.</span>
            <button type="button" className="button button--ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={!note.trim() || !canFix} title={canFix ? undefined : "Add your Z.ai key and scan plugins first"}>
              Research again
            </button>
          </div>
        </form>
      ) : (
        <div className="fix__row">
          <span className="tone-muted">Sounds off, or know something it got wrong? Tell it and it will research again.</span>
          <button type="button" className="button" onClick={() => setOpen(true)}>
            Something's off?
          </button>
        </div>
      )}
    </section>
  );
}

const TOPIC_LABEL: Record<FactTopic, string> = {
  players: "Who played",
  guitars: "Guitars",
  amps: "Amps",
  effects: "Effects",
  studio: "In the studio",
};

/** What the sources say on each research topic, so the player can see what is backed up. */
export function FactsCard({ facts, bridge }: { facts: NonNullable<ToneRecipe["facts"]>; bridge: ToneBridge }) {
  return (
    <section className="card extras facts">
      <h3 className="extras__title">What the sources say</h3>
      <dl className="facts__list">
        {FACT_TOPICS.filter((t) => facts[t]).map((topic) => {
          const fact = facts[topic]!;
          return (
            <div key={topic} className="facts__item" data-sourced={fact.sources.length > 0}>
              <dt>{TOPIC_LABEL[topic]}</dt>
              <dd>
                <p>{fact.finding}</p>
                {fact.sources.length > 0 ? (
                  <span className="facts__sources">
                    {fact.sources.map((url) => (
                      <button key={url} type="button" className="facts__source" title={url} onClick={() => void bridge.openExternal(url)}>
                        {describeSource(url).site}
                        <ExternalIcon className="source__icon" />
                      </button>
                    ))}
                  </span>
                ) : (
                  <span className="facts__none">No source found</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

interface ResearchLog extends ResearchTrace {
  startedAt: string;
  finishedAt: string;
}

/** What the model searched for and what came back, from the saved research log. */
export function ResearchLogCard({ savedId, bridge }: { savedId: string; bridge: ToneBridge }) {
  const [log, setLog] = useState<ResearchLog | null>();
  useEffect(() => {
    let live = true;
    bridge.research
      .latest(savedId)
      .then((json) => {
        if (live) setLog(json ? (JSON.parse(json) as ResearchLog) : null);
      })
      .catch(() => {
        if (live) setLog(null);
      });
    return () => {
      live = false;
    };
  }, [bridge, savedId]);

  if (log === undefined) return null;
  const seconds = log ? Math.round((Date.parse(log.finishedAt) - Date.parse(log.startedAt)) / 1000) : 0;
  return (
    <section className="card extras research-log">
      <h3 className="extras__title">How it was researched</h3>
      {log ? (
        <>
          <p className="tone-muted extras__intro">
            {log.searches.length} search{log.searches.length === 1 ? "" : "es"} by {log.model} in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            {(log.pages?.length ?? 0) > 0 && `, ${log.pages.length} page${log.pages.length === 1 ? "" : "s"} read`}
            {log.problems.length > 0 && `, ${log.problems.length} round${log.problems.length === 1 ? "" : "s"} of fixes`}
            {log.tokens > 0 && `, ${Math.round(log.tokens / 1000)}k tokens`}.
          </p>
          <ol className="research-log__list">
            {log.searches.map((search, i) => (
              <li key={i}>
                <details>
                  <summary>
                    <span className="research-log__query">{search.query}</span>
                    <span className="research-log__count">{search.error ? "failed" : `${search.results.length} results`}</span>
                  </summary>
                  <ul className="research-log__results">
                    {search.results.map((hit, j) => (
                      <li key={j}>
                        <button type="button" className="source" title={hit.link} onClick={() => void bridge.openExternal(hit.link)}>
                          <span className="source__site">{hit.title || describeSource(hit.link).site}</span>
                          <span className="source__page">{describeSource(hit.link).site}</span>
                          <ExternalIcon className="source__icon" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ol>
          {(log.pages?.length ?? 0) > 0 && (
            <>
              <h4 className="research-log__heading">Pages read in full</h4>
              <ul className="research-log__results research-log__pages">
                {log.pages.map((page, i) => (
                  <li key={i}>
                    <button type="button" className="source" title={page.url} onClick={() => void bridge.openExternal(page.url)}>
                      <span className="source__site">{page.title || describeSource(page.url).site}</span>
                      <span className="source__page">{page.error ? `Couldn't read: ${page.error}` : describeSource(page.url).site}</span>
                      <ExternalIcon className="source__icon" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {log.followUp?.length ? <p className="tone-muted research-log__note">The first draft had no source for {log.followUp.join(", ")}, so it went back to research {log.followUp.length === 1 ? "it" : "them"}.</p> : null}
          {log.dropped?.length ? <p className="tone-muted research-log__note">Removed {log.dropped.length} cited link{log.dropped.length === 1 ? "" : "s"} it never found.</p> : null}
        </>
      ) : (
        <p className="tone-muted extras__intro">No log for this tone. Logs are kept for searches run from now on.</p>
      )}
      <button type="button" className="button button--ghost research-log__folder" onClick={() => void bridge.research.openFolder()}>
        Open log folder
      </button>
    </section>
  );
}
