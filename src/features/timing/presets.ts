// Saved practice setups ("Kill the King intro, 140"): tempo, bar, click,
// riff and speed trainer together, so a riff is one click away next time.

import { sanitizeSettings, type TimingSettings } from "./useTimingSession";

export const PRESET_FIELDS = ["bpm", "beatsPerBar", "clicksPerBeat", "pattern", "riff", "trainer"] as const;
type PresetFields = Pick<TimingSettings, (typeof PRESET_FIELDS)[number]>;

export interface Preset extends PresetFields {
  id: string;
  name: string;
}

const pick = (settings: TimingSettings): PresetFields => ({
  bpm: settings.bpm,
  beatsPerBar: settings.beatsPerBar,
  clicksPerBeat: settings.clicksPerBeat,
  pattern: settings.pattern,
  riff: settings.riff,
  trainer: settings.trainer,
});

export function makePreset(settings: TimingSettings, name: string, id = `p-${Date.now().toString(36)}`): Preset {
  return { id, name: name.trim(), ...pick(settings) };
}

/** True when the current settings are exactly what the preset sets. */
export function matchesPreset(settings: TimingSettings, preset: Preset): boolean {
  return JSON.stringify(pick(settings)) === JSON.stringify(pick({ ...settings, ...preset }));
}

/** Repairs stored presets the same way stored settings are repaired. */
export function sanitizePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const raw = item as Partial<Preset> | null;
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.name.trim()) return [];
    return [{ id: raw.id, name: raw.name.trim(), ...pick(sanitizeSettings(raw)) }];
  });
}
