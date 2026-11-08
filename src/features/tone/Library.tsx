import { useEffect, useState } from "react";
import { usePersistentState } from "../../lib/usePersistentState.ts";
import type { SavedRecipe } from "./bridge.ts";
import { formatDuration, groupByDay, type HistoryEntry } from "./history.ts";
import { clearHistory, removeHistory, type ToneJob, type ToneView } from "./jobs.ts";
import { splitSavedId } from "./present.ts";
import type { SongMatch } from "./songs.ts";
import { CloseIcon, RefreshIcon } from "./tone-icons.tsx";

type Tab = "saved" | "history";

/** The current time, updated every second while mounted. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The sidebar: searches still running on top, then the saved tones and the
 * history of every search in two tabs.
 */
export function Library({
  jobs,
  saved,
  history,
  unseen,
  view,
  onOpen,
  onRemoveSaved,
  onSearchAgain,
}: {
  jobs: ToneJob[];
  saved: SavedRecipe[];
  history: HistoryEntry[];
  unseen: string[];
  view: ToneView;
  onOpen: (view: ToneView) => void;
  onRemoveSaved: (id: string) => void;
  onSearchAgain: (entry: HistoryEntry) => void;
}) {
  const [tab, setTab] = usePersistentState<Tab>("guitar-buddy.tone-library-tab", "saved", (v) => (v === "history" ? "history" : "saved"));
  const savedIds = new Set(saved.map((s) => s.id));
  const hasUnseen = unseen.some((id) => savedIds.has(id));

  return (
    <aside className="card library" aria-label="Your tones">
      {jobs.length > 0 && (
        <section className="library__section" aria-label="Searches in progress">
          <h2 className="library__label">In progress</h2>
          <ul className="library__list">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} open={view?.kind === "job" && view.id === job.id} onOpen={() => onOpen({ kind: "job", id: job.id })} />
            ))}
          </ul>
        </section>
      )}

      <div className="library__tabs" role="tablist" aria-label="Tone lists">
        <button type="button" role="tab" className="library__tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>
          Saved
          {saved.length > 0 && <span className="library__count">{saved.length}</span>}
          {hasUnseen && tab !== "saved" && <span className="library__new-dot" aria-label="New tone ready" />}
        </button>
        <button type="button" role="tab" className="library__tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
          History
          {history.length > 0 && <span className="library__count">{history.length}</span>}
        </button>
      </div>

      {tab === "saved" ? (
        saved.length === 0 ? (
          <p className="tone-muted library__empty">Tones you find are kept here, so opening them again is free.</p>
        ) : (
          <ul className="library__list" role="tabpanel" aria-label="Saved tones">
            {saved.map((item) => {
              const fallback = splitSavedId(item.id);
              const title = item.song ?? fallback.song;
              const artist = item.artist ?? fallback.artist;
              const isOpen = view?.kind === "saved" && view.id === item.id;
              return (
                <li key={item.id} className="library__item" data-open={isOpen}>
                  <button type="button" className="library__open" onClick={() => onOpen({ kind: "saved", id: item.id })} aria-current={isOpen || undefined}>
                    <span className="library__song">
                      {title}
                      {unseen.includes(item.id) && <span className="library__new">New</span>}
                    </span>
                    {artist && <span className="library__artist">{artist}</span>}
                  </button>
                  <button type="button" className="library__remove" aria-label={`Delete ${item.id}`} title="Delete" onClick={() => onRemoveSaved(item.id)}>
                    <CloseIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <HistoryList history={history} savedIds={savedIds} view={view} onOpen={onOpen} onSearchAgain={onSearchAgain} />
      )}
    </aside>
  );
}

function JobRow({ job, open, onOpen }: { job: ToneJob; open: boolean; onOpen: () => void }) {
  const now = useNow();
  const searches = job.steps.filter((s) => s.kind === "search").length;
  const meta =
    job.status === "failed"
      ? "Failed. Open to retry"
      : `${job.fix ? "Fixing · " : ""}${formatDuration(Math.max(0, Math.round((now - job.startedAt) / 1000)))} · ${searches} search${searches === 1 ? "" : "es"}`;
  return (
    <li className="library__item" data-open={open} data-state={job.status}>
      <button type="button" className="library__open library__open--art" onClick={onOpen} aria-current={open || undefined}>
        <span className="library__status" data-state={job.status} aria-hidden="true" />
        <span className="library__text">
          <span className="library__song">{job.song.title}</span>
          <span className="library__artist">{meta}</span>
        </span>
      </button>
    </li>
  );
}

const OUTCOME: Record<HistoryEntry["outcome"], string> = { saved: "Saved", failed: "Failed", stopped: "Stopped" };

function HistoryList({
  history,
  savedIds,
  view,
  onOpen,
  onSearchAgain,
}: {
  history: HistoryEntry[];
  savedIds: Set<string>;
  view: ToneView;
  onOpen: (view: ToneView) => void;
  onSearchAgain: (entry: HistoryEntry) => void;
}) {
  if (history.length === 0) {
    return <p className="tone-muted library__empty">Every song you search shows up here, including ones that failed or were stopped.</p>;
  }
  return (
    <div className="library__history" role="tabpanel" aria-label="Search history">
      {groupByDay(history).map((group) => (
        <section key={group.label} className="library__group">
          <h3 className="library__label">{group.label}</h3>
          <ul className="library__list">
            {group.entries.map((entry) => {
              const recipe = entry.savedId && savedIds.has(entry.savedId) ? entry.savedId : undefined;
              const outcome = entry.outcome === "saved" && !recipe ? "Deleted" : OUTCOME[entry.outcome];
              const time = new Date(entry.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
              const isOpen = Boolean(recipe && view?.kind === "saved" && view.id === recipe);
              const meta = [time, `${entry.searches} search${entry.searches === 1 ? "" : "es"}`, formatDuration(entry.seconds)].join(" · ");
              return (
                <li key={entry.id} className="library__item" data-open={isOpen}>
                  <button
                    type="button"
                    className="library__open library__open--art"
                    aria-current={isOpen || undefined}
                    title={recipe ? "Open this tone" : entry.error ? `${entry.error}\n\nClick to search again` : "Click to search again"}
                    onClick={() => (recipe ? onOpen({ kind: "saved", id: recipe }) : onSearchAgain(entry))}
                  >
                    <Art song={entry.song} />
                    <span className="library__text">
                      <span className="library__song">{entry.song.title}</span>
                      {entry.song.artist && <span className="library__artist">{entry.song.artist}</span>}
                      <span className="library__meta">
                        <span>{meta}</span>
                        {entry.fix && <span className="library__outcome" data-outcome="fix" title="Researched again with your notes">Fix</span>}
                        {(entry.outcome !== "saved" || !recipe) && (
                          <span className="library__outcome" data-outcome={outcome.toLowerCase()}>
                            {outcome}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                  <div className="library__actions">
                    {recipe && (
                      <button type="button" className="library__remove" aria-label={`Search ${entry.song.title} again`} title="Search again" onClick={() => onSearchAgain(entry)}>
                        <RefreshIcon />
                      </button>
                    )}
                    <button type="button" className="library__remove" aria-label={`Remove ${entry.song.title} from history`} title="Remove from history" onClick={() => removeHistory(entry.id)}>
                      <CloseIcon />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <button
        type="button"
        className="button button--ghost library__clear"
        onClick={() => {
          if (window.confirm("Clear the search history? Saved tones stay.")) clearHistory();
        }}
      >
        Clear history
      </button>
    </div>
  );
}

function Art({ song }: { song: SongMatch }) {
  return song.artwork ? (
    <img className="library__art" src={song.artwork} alt="" width={32} height={32} />
  ) : (
    <span className="library__art library__art--empty" aria-hidden="true">
      ♪
    </span>
  );
}
