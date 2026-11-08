import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { cleanError, toneBridge, type SavedRecipe, type ToneBridge } from "./bridge.ts";
import { binarySwitches, paramUnits, parseProbe, unitKnobs, type CatalogPlugin } from "./catalog.ts";
import { formatDuration, type HistoryEntry } from "./history.ts";
import { forgetSaved, recipeId, recordingOf, showView, startJob, stopJob, useToneJobs, type ToneJob, type ToneView } from "./jobs.ts";
import { Library, useNow } from "./Library.tsx";
import { findPlugin, parsePluginIni, PROBE_LIST } from "./plugins.ts";
import { splitSavedId } from "./present.ts";
import { buildParamProbeScript, buildReaperScript } from "./reaper-script.ts";
import { RecipeView, type Action, type RunResult } from "./RecipeView.tsx";
import { parseRecipe, type ToneRecipe } from "./recipe.ts";
import { SongPicker } from "./SongPicker.tsx";
import { parseSongSearch, type SongMatch } from "./songs.ts";
import { CloseIcon, RefreshIcon, SearchIcon } from "./tone-icons.tsx";
import "./tone.css";

export function ToneSearch() {
  if (!toneBridge) {
    return (
      <main className="page">
        <header className="page__header">
          <h1 className="page__title">Tone</h1>
        </header>
        <div className="alert" role="alert">
          Tone search talks to REAPER and Z.ai, so it only works in the desktop app. Start it with npm run desktop.
        </div>
      </main>
    );
  }
  return <ToneSearchDesktop bridge={toneBridge} />;
}

function ToneSearchDesktop({ bridge }: { bridge: ToneBridge }) {
  const [status, setStatus] = useState<{ hasKey: boolean; reaper: string | null }>();
  const [catalog, setCatalog] = useState<CatalogPlugin[] | null>();
  const [scanning, setScanning] = useState(false);
  const [song, setSong] = useState<SongMatch>();
  // Bumping n remounts the picker with new starting text (example songs).
  const [seed, setSeed] = useState({ n: 0, text: "" });
  const [notice, setNotice] = useState<string>();
  const [opened, setOpened] = useState<{ id: string; recipe: ToneRecipe }>();
  const [saved, setSaved] = useState<SavedRecipe[]>([]);
  const [busy, setBusy] = useState<Action>();
  const [run, setRun] = useState<RunResult>();
  const { jobs, view, history, unseen, savedVersion } = useToneJobs();
  const switches = useMemo(() => binarySwitches(catalog ?? []), [catalog]);
  const knobs = useMemo(() => unitKnobs(catalog ?? []), [catalog]);
  const units = useMemo(() => paramUnits(catalog ?? []), [catalog]);

  const refreshSaved = useCallback(() => bridge.recipes.list().then(setSaved), [bridge]);
  const findSongs = useCallback(async (term: string) => parseSongSearch(await bridge.findSongs(term)), [bridge]);

  useEffect(() => {
    void bridge.status().then(setStatus);
    void bridge.readProbe().then((json) => setCatalog(json ? parseProbe(json) : null));
  }, [bridge]);

  // Reload the list on mount and whenever a search writes a recipe.
  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved, savedVersion]);

  // Load the saved tone being shown (also when a search finishes while watched).
  const savedId = view?.kind === "saved" ? view.id : undefined;
  useEffect(() => {
    if (!savedId) return;
    let live = true;
    bridge.recipes
      .load(savedId)
      .then((json) => {
        if (live) setOpened({ id: savedId, recipe: parseRecipe(JSON.parse(json)) });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setNotice(`Could not open ${savedId}: ${cleanError(error)}`);
        showView(null);
      });
    return () => {
      live = false;
    };
  }, [bridge, savedId, savedVersion]);

  const scanPlugins = async () => {
    setScanning(true);
    try {
      const plugins = parsePluginIni(await bridge.readPluginIni());
      const names = PROBE_LIST.flatMap((q) => findPlugin(plugins, q)?.fxName ?? []);
      await bridge.runScript("Guitar Buddy - probe params", buildParamProbeScript(names), "last-probe.txt");
      const json = await bridge.readProbe();
      setCatalog(json ? parseProbe(json) : null);
    } catch (error) {
      setNotice(`Plugin scan failed: ${cleanError(error)}`);
    } finally {
      setScanning(false);
    }
  };

  const resetPicker = (text = "") => {
    setSong(undefined);
    setSeed((s) => ({ n: s.n + 1, text }));
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!song || !catalog) return;
    setRun(undefined);
    startJob(bridge, song, catalog);
    // The search runs on its own, so the box is free for the next song.
    resetPicker();
  };

  const open = (next: ToneView) => {
    setRun(undefined);
    showView(next);
    window.scrollTo({ top: 0 });
  };

  const removeSaved = async (id: string) => {
    await bridge.recipes.remove(id);
    forgetSaved(id);
    void refreshSaved();
  };

  /** Puts a song from the history back in the search box, ready to run again. */
  const searchAgain = (entry: HistoryEntry) => {
    setSeed((s) => ({ n: s.n + 1, text: "" }));
    setSong(entry.song);
    window.scrollTo({ top: 0 });
  };

  const recipe = savedId && opened?.id === savedId ? opened.recipe : undefined;

  const act = async (action: Action) => {
    if (!recipe) return;
    const id = recipeId(recipe);
    setBusy(action);
    setRun(undefined);
    try {
      if (action === "script") {
        const path = await bridge.saveDialog(`Guitar Buddy - ${id}`, "lua");
        if (!path) return;
        await bridge.writeFile(path, buildReaperScript(recipe, { newProject: false }));
        setRun({ action, warnings: 0, message: `Script saved to ${path}. In REAPER, load it from Actions > Show action list > New action > Load ReaScript.` });
        return;
      }
      let saveAs: string | undefined;
      if (action === "rpp") {
        saveAs = (await bridge.saveDialog(id, "rpp")) ?? undefined;
        if (!saveAs) return;
      }
      const lua = buildReaperScript(recipe, { newProject: action !== "add", saveAs });
      const { report } = await bridge.runScript(`Guitar Buddy - ${id}`, lua, "last-build.txt");
      const warnings = report.split("\n").filter((l) => /MISSING|not found|not understood/.test(l)).length;
      const parts = recipe.sections.length;
      const tracks = `${parts} track${parts === 1 ? "" : "s"}`;
      const message =
        action === "add"
          ? `Added ${tracks} to the open project. The first one is armed; arm another to switch parts.`
          : action === "tab"
            ? `Opened ${tracks} in a new REAPER tab.`
            : `Saved the project to ${saveAs}.`;
      setRun({ action, report, warnings, message });
    } catch (error) {
      setRun({ action, warnings: 1, message: cleanError(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const ready = Boolean(status?.hasKey && catalog);
  const pluginStatus = catalog ? `${catalog.length} plugins ready` : catalog === null ? "Plugins not scanned" : "Checking plugins…";
  const job = view?.kind === "job" ? jobs.find((j) => j.id === view.id) : undefined;
  const fixJob = recipe ? jobs.find((j) => j.status === "running" && j.song.id === recordingOf(recipe).id) : undefined;
  const runningForSong = Boolean(song && jobs.some((j) => j.status === "running" && j.song.id === song.id));

  return (
    <main className="page tone">
      <header className="page__header">
        <h1 className="page__title">Tone</h1>
        <div className="page__tools">
          <span className="chip" title={catalog ? catalog.map((p) => p.fx.replace(/^\w+:\s*/, "")).join("\n") : undefined}>
            <span className="dot" data-status={catalog ? "live" : catalog === null ? "error" : "starting"} />
            <span className="chip__text">{scanning ? "Scanning in REAPER…" : pluginStatus}</span>
          </span>
          <button type="button" className="button" disabled={scanning} onClick={() => void scanPlugins()} title="Reads every setting of your guitar plugins through REAPER">
            <RefreshIcon />
            {catalog ? "Rescan" : "Scan plugins"}
          </button>
        </div>
      </header>

      <div className="tone__layout">
        <div className="tone__main">
          {status && !status.hasKey && (
            <div className="alert" role="alert">
              Add your Z.ai key to the .env file next to package.json (ZAI_API_KEY=…), then restart the app.
            </div>
          )}
          {status && !status.reaper && (
            <div className="alert" role="alert">
              REAPER isn't installed in Program Files, so tones can be found and saved as scripts but not sent to REAPER.
            </div>
          )}
          {catalog === null && (
            <div className="alert" role="alert">
              <span>Scan your plugins once so tones use the knobs you own. REAPER adds a hidden track for a few seconds.</span>
              <button type="button" className="button" disabled={scanning} onClick={() => void scanPlugins()}>
                Scan plugins
              </button>
            </div>
          )}

          <form className="card finder" onSubmit={search}>
            <SearchIcon className="finder__icon" />
            <SongPicker key={seed.n} initialText={seed.text} selected={song} disabled={false} onSelect={setSong} find={findSongs} />
            {song && (
              <button
                type="submit"
                className="button button--primary finder__go"
                disabled={!ready}
                title={ready ? undefined : "Add your Z.ai key and scan plugins first"}
              >
                {runningForSong ? "Show search" : "Find tone"}
              </button>
            )}
          </form>

          {notice && (
            <div className="alert" role="alert">
              <span className="tone-pre">{notice}</span>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
                <CloseIcon />
              </button>
            </div>
          )}

          {(jobs.length > 0 || saved.length > 0) && (
            <nav className="library-chips" aria-label="Your tones">
              {jobs.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className="library-chips__item"
                  data-state={j.status}
                  aria-current={j.id === job?.id || undefined}
                  onClick={() => open({ kind: "job", id: j.id })}
                >
                  {j.song.title}
                  <span>{j.status === "running" ? (j.fix ? "Fixing…" : "Researching…") : "Failed"}</span>
                </button>
              ))}
              {saved.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="library-chips__item"
                  aria-current={item.id === savedId || undefined}
                  onClick={() => open({ kind: "saved", id: item.id })}
                >
                  {item.song ?? splitSavedId(item.id).song}
                  <span>{item.artist ?? splitSavedId(item.id).artist}</span>
                </button>
              ))}
            </nav>
          )}

          {job?.status === "running" && <Progress job={job} onStop={() => stopJob(job.id)} />}
          {job?.status === "failed" && (
            <section className="card progress" role="alert">
              <h2 className="progress__title">Couldn't {job.fix ? "fix" : "find"} the tone for {job.label}</h2>
              <p className="tone-pre">{job.error}</p>
              <div className="progress__actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!ready}
                  onClick={() => {
                    stopJob(job.id);
                    if (catalog) startJob(bridge, job.song, catalog, job.fix);
                  }}
                >
                  Try again
                </button>
                <button type="button" className="button" onClick={() => stopJob(job.id)}>
                  Dismiss
                </button>
              </div>
            </section>
          )}
          {recipe && (
            <RecipeView
              key={savedId}
              savedId={savedId}
              recipe={recipe}
              busy={busy}
              run={run}
              canRun={Boolean(status?.reaper)}
              onAction={(a) => void act(a)}
              bridge={bridge}
              switches={switches}
              knobs={knobs}
              units={units}
              canFix={ready}
              fixing={fixJob !== undefined}
              onShowFix={() => fixJob && open({ kind: "job", id: fixJob.id })}
              onFix={(note) => {
                if (!catalog) return;
                setRun(undefined);
                startJob(bridge, recordingOf(recipe), catalog, { notes: [...(recipe.notes ?? []), note], previous: recipe });
                window.scrollTo({ top: 0 });
              }}
            />
          )}
          {!view && <EmptyState onTry={(text) => resetPicker(text)} />}
        </div>

        <Library
          jobs={jobs}
          saved={saved}
          history={history}
          unseen={unseen}
          view={view}
          onOpen={open}
          onRemoveSaved={(id) => void removeSaved(id)}
          onSearchAgain={searchAgain}
        />
      </div>
    </main>
  );
}

// Songs from the player's practice list, to try with one click.
const EXAMPLES = [
  "High Hopes Pink Floyd",
  "Parisienne Walkways Gary Moore",
  "Smells Like Teen Spirit Nirvana",
  "Shine On You Crazy Diamond",
  "Benighted Opeth",
  "She's Moved On Porcupine Tree",
];

function EmptyState({ onTry }: { onTry: (text: string) => void }) {
  return (
    <section className="card empty" aria-label="How it works">
      <h2 className="empty__title">Get the tone of a record in REAPER</h2>
      <ol className="empty__steps">
        <li>
          <strong>Pick the recording</strong>
          <span>Search a song and choose the right artist and album from the list.</span>
        </li>
        <li>
          <strong>Let it research the rig</strong>
          <span>It reads rig rundowns and interviews, then sets up your own plugins to match. Takes 1 to 3 minutes and about $0.10.</span>
        </li>
        <li>
          <strong>Send it to REAPER</strong>
          <span>Add the tracks to your open project, or save them as a new project.</span>
        </li>
      </ol>
      <div className="examples">
        <h3 className="examples__title">Try one from your practice list</h3>
        <div className="examples__list">
          {EXAMPLES.map((text) => (
            <button key={text} type="button" className="examples__item" onClick={() => onTry(text)}>
              {text}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Progress({ job, onStop }: { job: ToneJob; onStop: () => void }) {
  const now = useNow();
  const seconds = Math.max(0, Math.round((now - job.startedAt) / 1000));
  const searches = job.steps.filter((s) => s.kind === "search").length;
  const pages = job.steps.filter((s) => s.kind === "reading").length;
  const research = job.steps.filter((s) => s.kind === "search" || s.kind === "reading");
  const last = job.steps.at(-1);
  return (
    <section className="card progress" aria-live="polite">
      <div className="progress__head">
        <h2 className="progress__title">
          {job.fix ? "Fixing" : "Researching"} {job.label}
        </h2>
        <span className="progress__time">{formatDuration(seconds)}</span>
        <button type="button" className="button button--ghost progress__stop" onClick={onStop}>
          Stop
        </button>
      </div>
      <div className="progress__bar" aria-hidden="true">
        <span />
      </div>
      <p className="tone-muted">
        {last?.kind === "writing" || last?.kind === "fixing"
          ? `${last.text} for your plugins…`
          : searches === 0
            ? "Planning what to look up…"
            : `${searches} search${searches === 1 ? "" : "es"}${pages ? ` and ${pages} page${pages === 1 ? "" : "s"} read` : ""} so far. Usually done in 1 to 4 minutes.`}
      </p>
      {job.fix && (
        <p className="progress__note">
          Applying your note: <q>{job.fix.notes.at(-1)}</q>
        </p>
      )}
      {research.length > 0 && (
        <ol className="progress__steps">
          {research.map((step, i) => (
            <li key={i} data-kind={step.kind}>
              {step.kind === "reading" && <span className="progress__reading">Reading</span>}
              {step.text}
            </li>
          ))}
        </ol>
      )}
      <p className="progress__hint">This keeps running if you open another tone, start another search or switch to Timing.</p>
    </section>
  );
}
