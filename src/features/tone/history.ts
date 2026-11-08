// Every tone search the player has run, newest first, kept in localStorage so
// it survives restarts. Saved tones are the recipe files; the history is the
// log of searches, including ones that failed or were stopped.

import type { SongMatch } from "./songs.ts";

export interface HistoryEntry {
  id: string;
  song: SongMatch;
  startedAt: number;
  seconds: number;
  searches: number;
  outcome: "saved" | "failed" | "stopped";
  /** The recipe file it produced, when it finished. */
  savedId?: string;
  error?: string;
  /** Research log file in userData/tone-research. */
  log?: string;
  /** A re-run with the player's corrections. */
  fix?: boolean;
}

const KEY = "guitar-buddy.tone-history";
export const HISTORY_LIMIT = 200;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full or blocked: the history just won't persist.
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  const e = value as HistoryEntry;
  return Boolean(e && typeof e.id === "string" && e.song && typeof e.song.title === "string" && typeof e.startedAt === "number");
}

export function addHistory(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...entries.filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT);
}

/** Groups entries under "Today", "Yesterday", or a date like "Mon 3 Nov". */
export function groupByDay(entries: HistoryEntry[], now = Date.now()): { label: string; entries: HistoryEntry[] }[] {
  const dayStart = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const today = dayStart(now);
  const groups: { label: string; entries: HistoryEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayStart(entry.startedAt);
    const diff = Math.round((today - day) / 86_400_000);
    const label =
      diff === 0
        ? "Today"
        : diff === 1
          ? "Yesterday"
          : new Date(day).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              ...(new Date(day).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
            });
    const last = groups.at(-1);
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

export const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
