import { useCallback, useEffect, useState } from "react";
import { SlidersIcon } from "../../components/icons";
import { LevelMeter } from "../../components/LevelMeter";
import { CountView } from "./CountView";
import { HitChart } from "./HitChart";
import { PresetBar, RiffCard, TrainerCard } from "./Practice";
import { RiffView } from "./RiffView";
import "./practice.css";
import { Readouts } from "./Readouts";
import { SettingsPanel } from "./SettingsPanel";
import { Transport } from "./Transport";
import { useTimingSession, type InputState } from "./useTimingSession";

const STATUS_TEXT: Record<InputState["status"], string> = {
  off: "Input off",
  starting: "Connecting…",
  live: "Listening",
  error: "Input unavailable",
};

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && target.closest("input, select, textarea, button, [role=dialog]") !== null;
}

export function TimingTrainer() {
  const session = useTimingSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { input, running, start, stop, tap } = session;
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (event.code === "KeyT") {
        tap();
        return;
      }
      if (event.code !== "Space") return;
      event.preventDefault();
      if (running) stop();
      else void start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, start, stop, tap]);

  return (
    <main className="page">
      <header className="page__header">
        <h1 className="page__title">Timing</h1>
        <div className="page__tools">
          {input.status === "live" ? (
            <span className="chip" title={input.label || undefined}>
              <span className="dot" data-status={input.status} />
              <span className="chip__text">{input.label || STATUS_TEXT.live}</span>
              <LevelMeter />
            </span>
          ) : (
            <button
              type="button"
              className="chip chip--action"
              title={input.status === "off" ? "Your guitar input opens when you press Play. Click to choose the input." : "Choose your guitar input"}
              onClick={() => setSettingsOpen(true)}
            >
              <span className="dot" data-status={input.status} />
              <span className="chip__text">{input.status === "off" ? "Input: idle" : STATUS_TEXT[input.status]}</span>
            </button>
          )}
          <button type="button" className="button" onClick={() => setSettingsOpen(true)}>
            <SlidersIcon />
            Settings
          </button>
        </div>
      </header>

      {input.status === "error" && (
        <div className="alert" role="alert">
          <span>{input.message} The click keeps running.</span>
          <button type="button" className="button" onClick={() => setSettingsOpen(true)}>
            Choose input
          </button>
        </div>
      )}

      <PresetBar session={session} />
      <Transport session={session} />
      <div className="practice">
        <RiffCard session={session} />
        <TrainerCard session={session} />
      </div>
      <Readouts session={session} />
      {session.settings.riff.enabled ? <RiffView session={session} /> : <CountView session={session} />}
      <HitChart session={session} />

      {settingsOpen && <SettingsPanel session={session} onClose={closeSettings} />}
    </main>
  );
}
