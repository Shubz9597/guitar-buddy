// Tone research runs here, outside the Tone screen, so a search keeps going
// while the player opens other tones or switches to Timing. The screen
// subscribes with useToneJobs() and picks up running searches when it mounts.

import { useSyncExternalStore } from "react";
import { cleanError, type ToneBridge } from "./bridge.ts";
import type { CatalogPlugin } from "./catalog.ts";
import { addHistory, loadHistory, saveHistory, type HistoryEntry } from "./history.ts";
import type { ToneRecipe } from "./recipe.ts";
import { DEFAULT_MODEL, emptyTrace, researchTone, type ResearchStep, type ResearchTrace } from "./research.ts";
import { songLabel, songQuery, type SongMatch } from "./songs.ts";

export interface ToneJob {
  id: string;
  song: SongMatch;
  label: string;
  steps: ResearchStep[];
  startedAt: number;
  status: "running" | "failed";
  error?: string;
  /** Set when the player asked to fix a saved tone. */
  fix?: ToneFix;
}

/** A correction to a saved tone: every note so far (newest last) and the recipe they are about. */
export interface ToneFix {
  notes: string[];
  previous: ToneRecipe;
}

/** What the main area shows: a running search, a saved tone, or the intro. */
export type ToneView = { kind: "job"; id: string } | { kind: "saved"; id: string } | null;

interface State {
  jobs: ToneJob[];
  view: ToneView;
  history: HistoryEntry[];
  /** Tones that finished while the player was looking at something else. */
  unseen: string[];
  /** Bumped whenever a recipe file is written, so the saved list reloads. */
  savedVersion: number;
}

let state: State = { jobs: [], view: null, history: loadHistory(), unseen: [], savedVersion: 0 };
const listeners = new Set<() => void>();
const runs = new Map<string, { controller: AbortController; trace: ResearchTrace; bridge: ToneBridge }>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  if (next.history) saveHistory(state.history);
  for (const listener of listeners) listener();
}

const updateJob = (id: string, change: Partial<ToneJob>) =>
  set({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...change } : job)) });

export const recipeId = (r: ToneRecipe) => `${r.artist} - ${r.song}`.replace(/[^\w\- ]+/g, "").trim();

/** "2026-11-07 220542", so log files sort by time. */
const stamp = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Writes everything the run did (searches, results, replies, problems) to
 * userData/tone-research, so the model's research can be checked later.
 * Never throws: a missing log must not break the search.
 */
async function saveLog(job: ToneJob, outcome: HistoryEntry["outcome"], extra: { savedId?: string; error?: string; recipe?: ToneRecipe } = {}) {
  const run = runs.get(job.id);
  if (!run) return undefined;
  const log = {
    song: job.song,
    label: job.label,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    outcome,
    ...extra,
    ...run.trace,
  };
  try {
    return await run.bridge.research.save(`${stamp(job.startedAt)} ${job.label}`, JSON.stringify(log, null, 2));
  } catch {
    return undefined;
  }
}

const record = (job: ToneJob, outcome: HistoryEntry["outcome"], extra: Partial<HistoryEntry> = {}) =>
  addHistory(state.history, {
    id: job.id,
    song: job.song,
    startedAt: job.startedAt,
    seconds: Math.round((Date.now() - job.startedAt) / 1000),
    searches: job.steps.filter((s) => s.kind === "search").length,
    outcome,
    ...extra,
  });

let counter = 0;

/** The recording a saved tone was made for (older files did not store it). */
export const recordingOf = (recipe: ToneRecipe): SongMatch =>
  recipe.recording ?? { id: `saved:${recipeId(recipe)}`, title: recipe.song, artist: recipe.artist };

/**
 * Starts researching a song, or shows the search already running for it.
 * With `fix`, it researches again with the player's corrections.
 */
export function startJob(bridge: ToneBridge, song: SongMatch, catalog: CatalogPlugin[], fix?: ToneFix): string {
  const running = state.jobs.find((job) => job.status === "running" && job.song.id === song.id);
  if (running) {
    set({ view: { kind: "job", id: running.id } });
    return running.id;
  }
  const id = `job-${Date.now()}-${++counter}`;
  const controller = new AbortController();
  const trace: ResearchTrace = emptyTrace(DEFAULT_MODEL, songQuery(song));
  runs.set(id, { controller, trace, bridge });
  const job: ToneJob = { id, song, label: songLabel(song), steps: [], startedAt: Date.now(), status: "running", ...(fix && { fix }) };
  set({ jobs: [job, ...state.jobs], view: { kind: "job", id } });

  void (async () => {
    try {
      const result = await researchTone(songQuery(song), catalog, (path, body) => bridge.zai(path, body), {
        signal: controller.signal,
        trace,
        readPage: (url) => bridge.fetchPage(url),
        notes: fix?.notes,
        previous: fix?.previous,
        onStep: (step) => {
          const current = state.jobs.find((j) => j.id === id);
          if (current) updateJob(id, { steps: [...current.steps, step] });
        },
      });
      if (controller.signal.aborted) return;
      // Keep the catalog's spelling of the recording the player picked.
      const named = song.artist ? { ...result.recipe, song: song.title, artist: song.artist } : result.recipe;
      // Notes are the player's own; never keep any the model wrote.
      const found: ToneRecipe = { ...named, notes: fix?.notes.length ? fix.notes : undefined, recording: song };
      const savedId = await bridge.recipes.save(recipeId(found), JSON.stringify(found, null, 2));
      const finished = state.jobs.find((j) => j.id === id) ?? job;
      const log = await saveLog(finished, "saved", { savedId, recipe: found });
      const watching = state.view?.kind === "job" && state.view.id === id;
      set({
        jobs: state.jobs.filter((j) => j.id !== id),
        view: watching ? { kind: "saved", id: savedId } : state.view,
        unseen: watching ? state.unseen : [...state.unseen.filter((u) => u !== savedId), savedId],
        history: record(finished, "saved", { savedId, log, ...(fix && { fix: true }) }),
        savedVersion: state.savedVersion + 1,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failed = state.jobs.find((j) => j.id === id) ?? job;
      const message = cleanError(error);
      updateJob(id, { status: "failed", error: message });
      const log = await saveLog(failed, "failed", { error: message });
      set({ history: record(failed, "failed", { error: message, log, ...(fix && { fix: true }) }) });
    } finally {
      // Stopped runs save their log from stopJob; keep the entry until then.
      if (!controller.signal.aborted) runs.delete(id);
    }
  })();
  return id;
}

/** Stops a running search, or clears a failed one from the list. */
export function stopJob(id: string) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  const wasRunning = job.status === "running";
  runs.get(id)?.controller.abort();
  set({
    jobs: state.jobs.filter((j) => j.id !== id),
    view: state.view?.kind === "job" && state.view.id === id ? null : state.view,
    // A failed search is already in the history; a stopped one is added now.
    ...(wasRunning ? { history: record(job, "stopped", job.fix ? { fix: true } : {}) } : {}),
  });
  if (wasRunning) {
    void saveLog(job, "stopped").then((log) => {
      runs.delete(id);
      if (log) set({ history: state.history.map((e) => (e.id === id ? { ...e, log } : e)) });
    });
  } else {
    runs.delete(id);
  }
}

export function showView(view: ToneView) {
  set({ view, unseen: view?.kind === "saved" ? state.unseen.filter((u) => u !== view.id) : state.unseen });
}

export function clearHistory() {
  set({ history: [] });
}

export function removeHistory(id: string) {
  set({ history: state.history.filter((entry) => entry.id !== id) });
}

/** Called after a saved tone is deleted, so nothing keeps pointing at it. */
export function forgetSaved(id: string) {
  set({
    view: state.view?.kind === "saved" && state.view.id === id ? null : state.view,
    unseen: state.unseen.filter((u) => u !== id),
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useToneJobs(): State {
  return useSyncExternalStore(subscribe, () => state);
}
