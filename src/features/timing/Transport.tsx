import { useEffect, useState, type RefObject } from "react";
import { Control, Segmented, Slider, Stepper } from "../../components/controls";
import { MinusIcon, PlayIcon, PlusIcon, StopIcon } from "../../components/icons";
import { audioEngine } from "../../audio/engine";
import { MAX_BPM, MIN_BPM, nextAccent, type Metronome } from "../../audio/metronome";
import type { Subdivision, SubdivisionSetting } from "./analysis";
import { riffPattern, type TimingSession } from "./useTimingSession";

export const SUBDIVISION_OPTIONS: { value: Subdivision; label: string; title: string }[] = [
  { value: 1, label: "1/4", title: "Quarter notes" },
  { value: 2, label: "1/8", title: "Eighth notes" },
  { value: 3, label: "1/12", title: "Eighth-note triplets" },
  { value: 4, label: "1/16", title: "Sixteenth notes" },
];

const PLAYING_OPTIONS: { value: SubdivisionSetting; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "Detect what you play" },
  ...SUBDIVISION_OPTIONS,
];

// Worded differently from "You play" on purpose: extra clicks are an opt-in,
// and practising subdivisions against beat-only clicks is the default.
const CLICK_OPTIONS: { value: Subdivision; label: string; title: string }[] = [
  { value: 1, label: "Beats", title: "Click on each beat only" },
  { value: 2, label: "+8ths", title: "Also click the eighth notes between beats" },
  { value: 3, label: "+12ths", title: "Also click the triplets between beats" },
  { value: 4, label: "+16ths", title: "Also click every sixteenth note" },
];

/** The step the listener is hearing right now, accounting for output latency. */
function useAudibleStep(metronome: RefObject<Metronome | null>, running: boolean) {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const tick = () => {
      const now = audioEngine.currentTimeMs / 1000 - audioEngine.outputLatency;
      let current = -1;
      for (const click of metronome.current?.scheduled ?? []) {
        if (click.time > now) break;
        current = click.step;
      }
      setStep(current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [metronome, running]);
  return running ? step : -1;
}

function TempoControl({ bpm, onChange, onTap }: { bpm: number; onChange: (bpm: number) => void; onTap: () => number }) {
  const [taps, setTaps] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && /^\d+$/.test(draft)) onChange(Number(draft));
    setDraft(null);
  };
  return (
    <div className="tempo">
      <span className="label">Tempo</span>
      <div className="tempo__row">
        <button type="button" className="tempo__nudge" aria-label="Slower" onClick={() => onChange(bpm - 1)}>
          <MinusIcon />
        </button>
        <input
          className="tempo__input"
          aria-label="Tempo in BPM"
          inputMode="numeric"
          maxLength={3}
          style={{ width: `${Math.max(2, (draft ?? String(bpm)).length) + 0.3}ch` }}
          value={draft ?? String(bpm)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => /^\d{0,3}$/.test(event.target.value) && setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(null);
              event.currentTarget.blur();
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              setDraft(null);
              onChange(bpm + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 5 : 1));
            }
          }}
        />
        <span className="tempo__unit">BPM</span>
        <button type="button" className="tempo__nudge" aria-label="Faster" onClick={() => onChange(bpm + 1)}>
          <PlusIcon />
        </button>
      </div>
      <Slider label="Tempo" min={MIN_BPM} max={MAX_BPM} value={bpm} onChange={onChange} />
      <button
        type="button"
        className="button button--ghost tempo__tap"
        title="Tap in time a few times to set the tempo (or press T)"
        onClick={() => setTaps(onTap())}
        onBlur={() => setTaps(0)}
      >
        {taps === 1 ? "Keep tapping…" : "Tap tempo"}
      </button>
    </div>
  );
}

export function Transport({ session }: { session: TimingSession }) {
  const { settings, update, running } = session;
  const activeStep = useAudibleStep(session.metronome, running);
  // While the click plays the riff, show that pattern (read-only) instead of the accents.
  const riffClick = settings.riff.enabled && settings.riff.click === "riff";
  const clicksPerBeat = riffClick ? 4 : settings.clicksPerBeat;
  const pattern = riffClick ? riffPattern(settings.riff.steps) : settings.pattern;
  const beats = Array.from({ length: settings.beatsPerBar }, (_, beat) => beat);

  return (
    <section className="card transport" aria-label="Metronome">
      <button
        type="button"
        className="go"
        aria-pressed={running}
        aria-label={running ? "Stop" : "Start"}
        title={running ? "Stop (Space)" : "Start (Space)"}
        onClick={running ? session.stop : () => void session.start()}
      >
        {running ? <StopIcon /> : <PlayIcon />}
      </button>

      <TempoControl bpm={settings.bpm} onChange={(bpm) => update({ bpm })} onTap={session.tap} />

      <div className="groove">
        <div className="groove__head">
          <span className="label">{riffClick ? "Click plays the riff" : "Accents"}</span>
          {riffClick ? (
            <span className="groove__hint">Edit it in Riff rhythm below</span>
          ) : (
          <span className="legend" aria-label="Click a beat to switch between accent, normal and muted">
            <span className="legend__item" data-accent="2">Accent</span>
            <span className="legend__item" data-accent="1">Normal</span>
            <span className="legend__item" data-accent="0">Muted</span>
          </span>
          )}
        </div>
        <div className="steps" aria-label="Click pattern: select a step to change its accent">
          {beats.map((beat) => (
            <div className="steps__beat" key={beat}>
              {Array.from({ length: clicksPerBeat }, (_, sub) => {
                const step = beat * clicksPerBeat + sub;
                const accent = pattern[step];
                return (
                  <button
                    key={sub}
                    type="button"
                    className={`step ${sub > 0 ? "step--sub" : ""}`}
                    title={riffClick ? undefined : "Click to switch accent, normal or muted"}
                    disabled={riffClick}
                    data-accent={accent}
                    data-active={step === activeStep}
                    aria-label={`Beat ${beat + 1}${sub ? `, subdivision ${sub + 1}` : ""}: ${
                      accent === 2 ? "accent" : accent === 0 ? "muted" : "normal"
                    }`}
                    onClick={() => {
                      const next = [...pattern];
                      next[step] = nextAccent(accent);
                      update({ pattern: next });
                    }}
                  >
                    {sub === 0 ? beat + 1 : ""}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="transport__controls">
        <Control label="You play">
          {settings.riff.enabled ? (
            <span className="transport__note">Your riff (checked in sixteenths)</span>
          ) : (
            <Segmented
              label="What you play"
              value={settings.playing}
              options={PLAYING_OPTIONS}
              onChange={(playing) => update({ playing })}
            />
          )}
        </Control>
        <Control label="Beats per bar">
          <Stepper label="Beats" min={1} max={12} value={settings.beatsPerBar} onChange={(beatsPerBar) => update({ beatsPerBar })} />
        </Control>
        <Control label="Click">
          <Segmented
            label="Click"
            value={settings.clicksPerBeat}
            options={CLICK_OPTIONS}
            onChange={(value) => update({ clicksPerBeat: value })}
          />
        </Control>
        <Control
          label={
            <>
              Volume <span className="control__value">{Math.round(settings.volume * 100)}%</span>
            </>
          }
          className="volume"
        >
          <Slider label="Click volume" min={0} max={100} value={Math.round(settings.volume * 100)} onChange={(value) => update({ volume: value / 100 })} />
        </Control>
      </div>
    </section>
  );
}
