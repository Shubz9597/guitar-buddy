import { useId, useState, type ReactNode } from "react";
import { Control, Segmented, Stepper } from "../../components/controls";
import { CloseIcon } from "../../components/icons";
import { clampBpm, MAX_BPM, MIN_BPM } from "../../audio/metronome";
import { usePersistentState } from "../../lib/usePersistentState";
import { makePreset, matchesPreset, sanitizePresets, type Preset } from "./presets";
import { formatCount, parseCount, stepName, STEPS_PER_BEAT } from "./riff";
import type { TimingSession } from "./useTimingSession";

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      {label}
    </button>
  );
}

function CardHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="practice-card__head">
      <h2 className="practice-card__title">{title}</h2>
      {children}
    </div>
  );
}

/** The riff's rhythm: typed as a count or clicked on a 16th-note grid. */
export function RiffCard({ session }: { session: TimingSession }) {
  const { settings, update } = session;
  const { riff } = settings;
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const parsed = draft === null ? null : parseCount(draft, settings.beatsPerBar);
  const error = parsed && "error" in parsed ? parsed.error : null;
  const setSteps = (steps: boolean[]) => update({ riff: { ...riff, steps } });
  const notes = riff.steps.filter(Boolean).length;

  return (
    <section className="card practice-card riff-card" data-on={riff.enabled} aria-label="Riff rhythm">
      <CardHead title="Riff rhythm">
        <Switch label="Check my riff" checked={riff.enabled} onChange={(enabled) => update({ riff: { ...riff, enabled } })} />
      </CardHead>
      <p className="hint">
        Type the count or click the steps. With the check on, every bar is scored note by note: missed notes, extra notes, early and late.
      </p>

      <div className="riff-count">
        <label className="label" htmlFor={inputId}>
          Count
        </label>
        <input
          id={inputId}
          className="riff-count__input"
          spellCheck={false}
          autoComplete="off"
          value={draft ?? formatCount(riff.steps)}
          placeholder="1 & 2 & 3 e & a 4 e & a"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            const result = parseCount(event.target.value, settings.beatsPerBar);
            if ("steps" in result) setSteps(result.steps);
          }}
          onBlur={() => !error && setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
        {error ? (
          <p className="riff-count__error" id={`${inputId}-error`} role="alert">
            {error}
          </p>
        ) : (
          <p className="riff-count__meta">
            {notes} note{notes === 1 ? "" : "s"} per bar of {settings.beatsPerBar}
          </p>
        )}
      </div>

      <div className="riff-grid" aria-label="Riff steps: select a step to play it or rest">
        {Array.from({ length: settings.beatsPerBar }, (_, beat) => (
          <div className="riff-grid__beat" key={beat}>
            {Array.from({ length: STEPS_PER_BEAT }, (_, sub) => {
              const step = beat * STEPS_PER_BEAT + sub;
              const on = riff.steps[step];
              return (
                <button
                  key={sub}
                  type="button"
                  className="riff-step"
                  data-on={on}
                  data-beat={sub === 0}
                  aria-pressed={on}
                  aria-label={`${stepName(step)}: ${on ? "played" : "rest"}`}
                  onClick={() => {
                    setDraft(null);
                    setSteps(riff.steps.map((value, i) => (i === step ? !value : value)));
                  }}
                >
                  {sub === 0 ? beat + 1 : ["", "e", "&", "a"][sub]}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <Control label="Click plays">
        <Segmented
          label="Click plays"
          value={riff.click}
          options={[
            { value: "beat", label: "The beat", title: "Your usual click" },
            { value: "riff", label: "The riff", title: "Clicks the riff's rhythm on top of every beat, so you can hear how it goes" },
          ]}
          onChange={(click) => update({ riff: { ...riff, click, enabled: click === "riff" ? true : riff.enabled } })}
        />
      </Control>
    </section>
  );
}

function BpmField({ label, value, onChange }: { label: string; value: number; onChange: (bpm: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && /^\d+$/.test(draft)) onChange(clampBpm(Number(draft)));
    setDraft(null);
  };
  return (
    <label className="bpm-field">
      <span className="label">{label}</span>
      <span className="bpm-field__box">
        <input
          inputMode="numeric"
          maxLength={3}
          aria-label={`${label} BPM`}
          title={`${MIN_BPM} to ${MAX_BPM}`}
          value={draft ?? String(value)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => /^\d{0,3}$/.test(event.target.value) && setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
        <span>BPM</span>
      </span>
    </label>
  );
}

/** Speeds the click up step by step, after clean bars (riff on) or every few bars. */
export function TrainerCard({ session }: { session: TimingSession }) {
  const { settings, update, trainer } = session;
  const set = (patch: Partial<typeof settings.trainer>) => update({ trainer: { ...settings.trainer, ...patch } });
  const unit = trainer.clean ? "clean bars in a row" : "bars";
  const next = Math.min(trainer.to, settings.bpm + trainer.step);

  return (
    <section className="card practice-card trainer-card" data-on={trainer.enabled} aria-label="Speed trainer">
      <CardHead title="Speed trainer">
        <Switch label="Speed up as I go" checked={trainer.enabled} onChange={(enabled) => set({ enabled })} />
      </CardHead>
      <div className="trainer-fields">
        <BpmField label="Start at" value={trainer.from} onChange={(from) => set({ from })} />
        <BpmField label="Goal" value={trainer.to} onChange={(to) => set({ to })} />
        <Control label={`+${trainer.step} BPM each step`}>
          <Stepper label="BPM per step" min={1} max={20} value={trainer.step} onChange={(step) => set({ step })} />
        </Control>
        <Control label={`After ${trainer.bars} ${unit}`}>
          <Stepper label="Bars" min={1} max={16} value={trainer.bars} onChange={(bars) => set({ bars })} />
        </Control>
      </div>

      {trainer.active ? (
        trainer.done ? (
          <p className="trainer-status" data-done="true" role="status">
            Goal reached: {trainer.bars} {unit} at {settings.bpm} BPM.
          </p>
        ) : (
          <div className="trainer-status" role="status">
            <span>
              <strong className="num">{settings.bpm}</strong> BPM now
              {settings.bpm < trainer.to ? (
                <>
                  {" "}
                  · <span className="num">{next}</span> next
                </>
              ) : (
                " · goal tempo"
              )}
            </span>
            <span className="trainer-status__dots" aria-label={`${trainer.progress} of ${trainer.bars} ${unit}`}>
              {Array.from({ length: trainer.bars }, (_, i) => (
                <span key={i} data-done={i < trainer.progress} />
              ))}
            </span>
          </div>
        )
      ) : (
        <p className="hint">
          {trainer.enabled
            ? `Press Start: it begins at ${trainer.from} BPM and climbs to ${trainer.to}.`
            : trainer.clean
              ? "Speeds up only after clean bars, so you earn each step."
              : "Turn on the riff check to speed up only after clean bars; otherwise it speeds up every few bars."}
        </p>
      )}
    </section>
  );
}

/** Save and load practice setups: tempo, bar, click, riff and trainer. */
export function PresetBar({ session }: { session: TimingSession }) {
  const { settings, update } = session;
  const [presets, setPresets] = usePersistentState<Preset[]>("guitar-buddy.timing-presets", [], sanitizePresets);
  const [selectedId, setSelectedId] = usePersistentState<string>("guitar-buddy.timing-preset", "", (v) => (typeof v === "string" ? v : ""));
  const [naming, setNaming] = useState<string | null>(null);
  const selected = presets.find((p) => p.id === selectedId);
  const changed = selected ? !matchesPreset(settings, selected) : false;

  const load = (id: string) => {
    setSelectedId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const { bpm, beatsPerBar, clicksPerBeat, pattern, riff, trainer } = preset;
    update({ bpm, beatsPerBar, clicksPerBeat, pattern, riff, trainer: { ...trainer, enabled: false } });
    // Switching the trainer on would reset the tempo; set it as saved afterwards.
    if (trainer.enabled) update({ trainer, bpm });
  };

  const save = () => {
    if (!naming?.trim()) return;
    const preset = makePreset(settings, naming);
    setPresets([...presets.filter((p) => p.name !== preset.name), preset].sort((a, b) => a.name.localeCompare(b.name)));
    setSelectedId(preset.id);
    setNaming(null);
  };

  if (naming !== null) {
    return (
      <form
        className="presets"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <span className="label">Save as</span>
        <input
          className="presets__name"
          autoFocus
          maxLength={60}
          aria-label="Preset name"
          placeholder="e.g. Kill the King intro"
          value={naming}
          onChange={(event) => setNaming(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && setNaming(null)}
        />
        <button type="submit" className="button button--primary" disabled={!naming.trim()}>
          Save
        </button>
        <button type="button" className="button button--ghost" onClick={() => setNaming(null)}>
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="presets">
      <span className="label">Preset</span>
      <select className="presets__select" aria-label="Preset" value={selected ? selected.id : ""} onChange={(event) => load(event.target.value)}>
        <option value="">{presets.length ? "Choose a preset…" : "No presets yet"}</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.bpm} BPM
          </option>
        ))}
      </select>
      {selected && changed && <span className="presets__changed">Changed</span>}
      {selected && changed && (
        <button
          type="button"
          className="button"
          title={`Overwrite "${selected.name}" with the current settings`}
          onClick={() => setPresets(presets.map((p) => (p.id === selected.id ? makePreset(settings, p.name, p.id) : p)))}
        >
          Update
        </button>
      )}
      <button type="button" className="button" onClick={() => setNaming(selected && changed ? `${selected.name} (copy)` : "")}>
        Save as…
      </button>
      {selected && (
        <button
          type="button"
          className="icon-button"
          aria-label={`Delete preset ${selected.name}`}
          title="Delete this preset"
          onClick={() => {
            setPresets(presets.filter((p) => p.id !== selected.id));
            setSelectedId("");
          }}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
