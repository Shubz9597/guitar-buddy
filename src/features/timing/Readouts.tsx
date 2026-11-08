import { countName, gradeHit, LOOSE_MS, SUBDIVISION_NAMES, TIGHT_MS, type HitGrade } from "./analysis";
import type { TimingSession } from "./useTimingSession";

function signed(value: number) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}`;
}

function describeOffset(errorMs: number) {
  const size = Math.round(Math.abs(errorMs));
  if (size <= 3) return "Dead on";
  return `${size} ms ${errorMs < 0 ? "early" : "late"}`;
}

/** A labelled bar every readout uses: optional target zone, marker and fill. */
function Meter({
  left,
  right,
  zone,
  marker,
  fill,
}: {
  left: string;
  right: string;
  zone?: { from: string; to: string };
  marker?: string;
  fill?: string;
}) {
  return (
    <div>
      <div className="gauge" aria-hidden>
        <div className="gauge__track" />
        {fill !== undefined && <div className="gauge__fill" style={{ width: fill }} />}
        {zone && <div className="gauge__zone" style={{ left: zone.from, right: `calc(100% - ${zone.to})` }} />}
        {marker && <div className="gauge__marker" style={{ left: marker }} />}
      </div>
      <div className="gauge__labels">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

// Tempo bar spans the click tempo ±5 BPM; the target zone is ±1 BPM.
const TEMPO_RANGE = 5;
const tempoPosition = (difference: number) =>
  `${50 + (Math.max(-TEMPO_RANGE, Math.min(TEMPO_RANGE, difference)) / TEMPO_RANGE) * 50}%`;

function TempoReadout({ session }: { session: TimingSession }) {
  const { tempo, settings, running } = session;
  const difference = tempo ? tempo.bpm - settings.bpm : 0;
  const grade: HitGrade = Math.abs(difference) < 1 ? "tight" : Math.abs(difference) < 3 ? "close" : "off";

  return (
    <article className="card readout" data-grade={tempo ? grade : undefined} data-empty={!tempo}>
      <div className="readout__top">
        <h2 className="readout__title">Your tempo</h2>
        {tempo &&
          (tempo.followsClick ? (
            <span className="badge" data-grade={grade}>
              {Math.abs(difference) < 0.5 ? "On the click" : `${difference > 0 ? "+" : "−"}${Math.abs(difference).toFixed(1)} vs click`}
            </span>
          ) : (
            <span className="badge" data-grade="off">
              Not following the click
            </span>
          ))}
      </div>
      <div className="readout__value" data-empty={!tempo}>
        <span>{tempo ? tempo.bpm.toFixed(1) : "–"}</span>
        <small>BPM</small>
      </div>
      <Meter
        left="Slower"
        right="Faster"
        zone={{ from: tempoPosition(-1), to: tempoPosition(1) }}
        marker={tempo ? tempoPosition(difference) : undefined}
      />
      <div className="readout__foot">
        {tempo ? (
          <>
            <strong>{SUBDIVISION_NAMES[tempo.subdivision]}</strong> ·{" "}
            {tempo.spreadMs > LOOSE_MS / 1.5 ? (
              <span className="readout__uneven">uneven, notes wander ±{Math.round(tempo.spreadMs)} ms</span>
            ) : (
              <>steady to ±{Math.round(tempo.spreadMs)} ms</>
            )}
          </>
        ) : running ? (
          "Keep playing: tempo appears after a few notes"
        ) : (
          "Press start and play along"
        )}
      </div>
    </article>
  );
}

function LastHitReadout({ session }: { session: TimingSession }) {
  const last = session.hits.at(-1);
  const grade = last ? gradeHit(last.errorMs) : undefined;
  const range = LOOSE_MS * 2;
  const position = (value: number) => `${50 + (Math.max(-range, Math.min(range, value)) / range) * 50}%`;

  return (
    <article className="card readout" data-grade={grade} data-empty={!last}>
      <div className="readout__top">
        <h2 className="readout__title">Last note</h2>
        {last && (
          <span className="badge" data-grade={grade}>
            {countName(last.slot, session.subdivision, session.settings.beatsPerBar)} · {describeOffset(last.errorMs)}
          </span>
        )}
      </div>
      <div className="readout__value" data-grade={grade} data-empty={!last}>
        <span>{last ? signed(last.errorMs) : "–"}</span>
        <small>ms</small>
      </div>
      <Meter
        left="Early"
        right="Late"
        zone={{ from: position(-TIGHT_MS), to: position(TIGHT_MS) }}
        marker={last ? position(last.errorMs) : undefined}
      />
      <div className="readout__foot">
        {last ? `Green zone is within ±${TIGHT_MS} ms of the click` : "How far each note lands from the click"}
      </div>
    </article>
  );
}

function AccuracyReadout({ session }: { session: TimingSession }) {
  const { summary } = session;
  const grade: HitGrade | undefined = summary
    ? summary.tightPercent >= 80
      ? "tight"
      : summary.tightPercent >= 50
        ? "close"
        : "off"
    : undefined;

  return (
    <article className="card readout" data-grade={grade} data-empty={!summary}>
      <div className="readout__top">
        <h2 className="readout__title">On time</h2>
        {summary && <span className="badge">{summary.count} notes</span>}
      </div>
      <div className="readout__value" data-grade={grade} data-empty={!summary}>
        <span>{summary ? summary.tightPercent : "–"}</span>
        <small>% within ±{TIGHT_MS} ms</small>
      </div>
      <Meter left="0%" right="100%" fill={`${summary?.tightPercent ?? 0}%`} />
      <div className="readout__foot">
        {summary ? (
          <>
            {Math.abs(summary.meanMs) < 3 ? (
              <strong>Centred on the beat</strong>
            ) : (
              <>
                Tends <strong>{Math.round(Math.abs(summary.meanMs))} ms {summary.meanMs < 0 ? "early" : "late"}</strong>
              </>
            )}{" "}
            · spread ±{Math.round(summary.spreadMs)} ms
          </>
        ) : (
          "Every note is compared with the click"
        )}
      </div>
    </article>
  );
}

export function Readouts({ session }: { session: TimingSession }) {
  return (
    <section className="readouts" aria-label="Results">
      <TempoReadout session={session} />
      <LastHitReadout session={session} />
      <AccuracyReadout session={session} />
    </section>
  );
}
