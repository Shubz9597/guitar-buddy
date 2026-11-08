import { gradeHit, TIGHT_MS } from "./analysis";
import { cleanStreak, statsByNote, stepName, type BarResult, type NoteStats } from "./riff";
import type { TimingSession } from "./useTimingSession";

const SHOWN_BARS = 8;

function signed(value: number) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}`;
}

/** The one or two things most worth working on, in words. */
function advice(stats: NoteStats[], bars: BarResult[], start: number): string | null {
  const played = bars.filter((b) => b.complete && !b.empty);
  if (played.length < 2) return null;
  if (start) return `It sounds like you start the riff on “${stepName(start)}” instead of “1”. Start it on the high accented click.`;
  const lines: string[] = [];
  const missed = stats.filter((s) => s.due - s.hit > 0).sort((a, b) => b.due - b.hit - (a.due - a.hit))[0];
  if (missed && (missed.due - missed.hit) / missed.due >= 0.2) {
    lines.push(`You miss “${stepName(missed.step)}” in ${missed.due - missed.hit} of ${missed.due} bars.`);
  }
  const off = stats.filter((s) => s.meanMs !== null && s.hit >= 2).sort((a, b) => Math.abs(b.meanMs!) - Math.abs(a.meanMs!))[0];
  if (off && Math.abs(off.meanMs!) > TIGHT_MS / 2) {
    lines.push(`“${stepName(off.step)}” lands ${Math.round(Math.abs(off.meanMs!))} ms ${off.meanMs! < 0 ? "early" : "late"} on average.`);
  }
  const extras = played.reduce((n, b) => n + b.extras.length, 0);
  if (extras >= 2) lines.push(`${extras} extra notes on rests: mute the strings between chugs.`);
  return lines.length ? lines.join(" ") : "Every note of the riff is landing. Try the next tempo.";
}

function BarRow({ bar, latest }: { bar: BarResult; latest: boolean }) {
  const status = !bar.complete ? "playing" : bar.clean ? "clean" : "slip";
  return (
    <li className="bar-row" data-status={status} data-latest={latest || undefined}>
      <span className="bar-row__name num">Bar {bar.bar + 1}</span>
      <span className="bar-row__notes">
        {bar.notes.map((note) => {
          const state = note.errorMs === undefined ? "due" : note.errorMs === null ? "missed" : gradeHit(note.errorMs);
          const label =
            note.errorMs === undefined ? "coming up" : note.errorMs === null ? "missed" : `${signed(note.errorMs)} ms`;
          return (
            <span key={note.step} className="bar-note" data-state={state} title={`${stepName(note.step)}: ${label}`}>
              {note.errorMs === null ? "×" : state === "off" ? signed(note.errorMs!) : ""}
            </span>
          );
        })}
      </span>
      <span className="bar-row__meta">
        {bar.extras.length > 0 && <span className="bar-row__extra">+{bar.extras.length} extra</span>}
        <span className="num">
          {bar.hit}/{bar.notes.length}
        </span>
        {bar.meanMs !== null && <span className="num bar-row__mean">{signed(bar.meanMs)} ms</span>}
      </span>
    </li>
  );
}

export function RiffView({ session }: { session: TimingSession }) {
  const bars = session.riffBars.filter((b) => !b.empty);
  const steps = session.settings.riff.steps;
  const notes = steps.flatMap((on, i) => (on ? [i] : []));
  const stats = statsByNote(session.riffBars);
  const streak = cleanStreak(session.riffBars);
  const complete = bars.filter((b) => b.complete);
  const clean = complete.filter((b) => b.clean).length;
  const shown = bars.slice(-SHOWN_BARS).reverse();
  const text = advice(stats, session.riffBars, session.riffStart);

  return (
    <section className="card riff-view" aria-label="Riff, bar by bar">
      <div className="chart-card__header">
        <h2 className="chart-card__title">Bar by bar</h2>
        <p className="count__insight" data-warn={session.riffStart ? true : undefined}>{text ?? (session.running ? "Play the riff: each bar is checked as it ends" : "Press Start and play the riff")}</p>
      </div>

      {complete.length > 0 && (
        <div className="riff-score">
          <div className="riff-score__item" data-grade={streak > 0 ? "tight" : undefined}>
            <span className="riff-score__value num">{streak}</span>
            <span className="riff-score__label">clean in a row</span>
          </div>
          <div className="riff-score__item">
            <span className="riff-score__value num">
              {clean}/{complete.length}
            </span>
            <span className="riff-score__label">clean bars</span>
          </div>
          <p className="riff-score__rule">Clean: every note played, none extra, all within ±45 ms.</p>
        </div>
      )}

      <div className="riff-table">
        <div className="bar-row bar-row--head" aria-hidden="true">
          <span className="bar-row__name" />
          <span className="bar-row__notes">
            {notes.map((step) => (
              <span key={step} className="bar-note bar-note--label" data-beat={step % 4 === 0}>
                {stepName(step).split(" ").at(-1)}
              </span>
            ))}
          </span>
          <span className="bar-row__meta" />
        </div>
        {shown.length > 0 ? (
          <ol className="riff-bars">
            {shown.map((bar, i) => (
              <BarRow key={bar.bar} bar={bar} latest={i === 0} />
            ))}
          </ol>
        ) : (
          <p className="riff-empty">Your bars show up here, newest on top.</p>
        )}
        {stats.length > 0 && (
          <div className="bar-row bar-row--avg">
            <span className="bar-row__name">Average</span>
            <span className="bar-row__notes">
              {stats.map((s) => (
                <span
                  key={s.step}
                  className="bar-note bar-note--avg num"
                  data-state={s.meanMs === null ? "missed" : gradeHit(s.meanMs)}
                  title={`${stepName(s.step)}: ${s.meanMs === null ? "never played" : `${signed(s.meanMs)} ms average`}, played ${s.hit} of ${s.due} bars`}
                >
                  {s.meanMs === null ? "–" : signed(s.meanMs)}
                </span>
              ))}
            </span>
            <span className="bar-row__meta">ms</span>
          </div>
        )}
      </div>
    </section>
  );
}
