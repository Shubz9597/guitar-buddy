import { useEffect } from "react";
import { Segmented, Slider } from "../../components/controls";
import { CloseIcon } from "../../components/icons";
import { LevelMeter } from "../../components/LevelMeter";
import { canSelectOutput } from "../../audio/engine";
import { useAudioDevices } from "../../audio/useAudioDevices";
import type { TimingSession } from "./useTimingSession";

function Calibration({ session }: { session: TimingSession }) {
  const { calibration } = session;
  if (calibration.phase === "listening") {
    return (
      <div className="calibration" role="status">
        <span>Play one short, clean note exactly on every click…</span>
        <div className="calibration__progress" aria-label={`${calibration.collected} of 12 notes`}>
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} data-done={i < calibration.collected} />
          ))}
        </div>
        <div>
          <button type="button" className="button button--ghost" onClick={session.cancelCalibration}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="row">
      <span className="hint" role="status">
        {calibration.phase === "done"
          ? `Calibrated: ${calibration.offsetMs > 0 ? "+" : ""}${calibration.offsetMs} ms correction.`
          : calibration.phase === "failed"
            ? calibration.reason
            : "Measures your setup's delay while you play along with 12 clicks."}
      </span>
      <button type="button" className="button" onClick={() => void session.startCalibration()}>
        Calibrate
      </button>
    </div>
  );
}

export function SettingsPanel({ session, onClose }: { session: TimingSession; onClose: () => void }) {
  const { settings, update, input } = session;
  const devices = useAudioDevices();
  const { refresh } = devices;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Device names become readable once the input is open.
  useEffect(() => {
    if (input.status === "live") void refresh();
  }, [input.status, refresh]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="drawer__header">
          <h2>Settings</h2>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="drawer__body">
          <section className="section">
            <h3>Guitar input</h3>
            <select
              aria-label="Guitar input device"
              value={settings.inputDeviceId}
              onChange={(event) => update({ inputDeviceId: event.target.value })}
            >
              <option value="">System default input</option>
              {devices.inputs.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
            {!devices.labelled && (
              <div className="row">
                <span className="hint">Device names are hidden until input access is allowed.</span>
                <button type="button" className="button" onClick={() => void devices.requestAccess().catch(() => {})}>
                  Allow
                </button>
              </div>
            )}
            {input.status === "live" ? (
              <LevelMeter wide />
            ) : (
              <p className="hint">The level meter works while the click is running.</p>
            )}
            <p className="hint">
              Use a dry guitar signal (interface, DI or a VoiceMeeter bus). A microphone will also hear the click,
              and delay or reverb adds extra notes.
            </p>
          </section>

          <section className="section">
            <h3>Note detection</h3>
            <div className="row">
              <span className="label">Playing style</span>
              <Segmented
                label="Playing style"
                value={settings.style}
                options={[
                  { value: "pick", label: "Single notes" },
                  { value: "strum", label: "Strumming" },
                ]}
                onChange={(style) => update({ style })}
              />
            </div>
            <div className="control">
              <div className="row">
                <span className="label">Sensitivity</span>
                <output className="num">{settings.sensitivity}</output>
              </div>
              <Slider label="Sensitivity" min={1} max={10} value={settings.sensitivity} onChange={(sensitivity) => update({ sensitivity })} />
              <p className="hint">Raise it if quiet notes are missed; lower it if noise shows up as notes.</p>
            </div>
          </section>

          {canSelectOutput && (
            <section className="section">
              <h3>Click output</h3>
              <select
                aria-label="Click output device"
                value={settings.outputDeviceId}
                onChange={(event) => update({ outputDeviceId: event.target.value })}
              >
                <option value="">System default output</option>
                {devices.outputs.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label}
                  </option>
                ))}
              </select>
            </section>
          )}

          <section className="section">
            <h3>Latency</h3>
            <p className="hint">
              Audio takes time to reach your ears and come back from the interface. Calibrate once per setup so
              “on time” really means on time.
            </p>
            <Calibration session={session} />
            <div className="control">
              <div className="row">
                <span className="label">Correction</span>
                <output className="num">
                  {settings.latencyOffsetMs > 0 ? "+" : ""}
                  {settings.latencyOffsetMs} ms
                </output>
              </div>
              <Slider
                label="Latency correction"
                min={-150}
                max={400}
                value={settings.latencyOffsetMs}
                onChange={(latencyOffsetMs) => update({ latencyOffsetMs })}
              />
              <p className="hint">
                {input.status === "live"
                  ? `Applied in addition to the ${input.reportedLatencyMs} ms your system reports.`
                  : "Applied in addition to the delay your system reports."}
              </p>
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
