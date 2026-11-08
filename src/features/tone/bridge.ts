// Typed access to the desktop bridge from electron/preload.cjs. In a plain
// browser (npm run dev) there is no bridge and the Tone screen says so.

import type { ZaiPath } from "./research.ts";

export interface SavedRecipe {
  id: string;
  savedAt: number;
  /** Read from the file, so names keep their punctuation ("Panic! At the Disco"). */
  song?: string;
  artist?: string;
}

export interface ToneBridge {
  status(): Promise<{ hasKey: boolean; reaper: string | null }>;
  readPluginIni(): Promise<string>;
  readProbe(): Promise<string | null>;
  zai(path: ZaiPath, body: unknown): Promise<unknown>;
  runScript(name: string, lua: string, reportFile: "last-build.txt" | "last-probe.txt"): Promise<{ script: string; report: string }>;
  saveDialog(defaultName: string, ext: "rpp" | "lua" | "json"): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  recipes: {
    list(): Promise<SavedRecipe[]>;
    load(id: string): Promise<string>;
    save(id: string, json: string): Promise<string>;
    remove(id: string): Promise<void>;
  };
  /** Research logs in userData/tone-research, one file per run. */
  research: {
    /** Writes a log; returns its file name. */
    save(name: string, json: string): Promise<string>;
    /** The newest log that produced this saved tone, or null. */
    latest(savedId: string): Promise<string | null>;
    openFolder(): Promise<void>;
  };
  /** Raw iTunes Search API response; parse with parseSongSearch. */
  findSongs(term: string): Promise<unknown>;
  /** HTML of a public web page, for the researcher to read in full. */
  fetchPage(url: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    guitarBuddy?: { tone: ToneBridge };
  }
}

export const toneBridge: ToneBridge | undefined = typeof window === "undefined" ? undefined : window.guitarBuddy?.tone;

/** Electron prefixes errors from main with "Error invoking remote method ...: Error: ". */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
