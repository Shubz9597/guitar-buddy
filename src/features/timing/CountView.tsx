import { countName, gradeHit, statsByCount, TIGHT_MS, type CountStats } from "./analysis";
import type { Hit, TimingSession } from "./useTimingSession";

// Half a cell represents this many ms, so small offsets are still visible.
const CELL_SCALE_MS = 60;
const MIN_NOTES_PER_COUNT = 3;

function signed(value: number) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}`;
}

function countPlural(stat: CountStats) {
  return stat.index === 0 ? "downbeats" : `“${stat.syllable}” notes`;
}

function insight(stats: CountStats[]) {
  const measured = stats.filter((stat) => stat.count >= MIN_NOTES_PER_COUNT);
  if (measured.length === 0) return null;
  const worst = measured.reduce((a, b) => (Math.abs(b.meanMs) > Math.abs(a.meanMs) ? b : a));
  const loosest = measured.reduce((a, b) => (b.spreadMs > a.spreadMs ? b : a));
  const lines: string[] = [];
  if (Math.abs(worst.meanMs) > TIGHT_MS / 2) {
    lines.push(
      `Your ${countPlural(worst)} land ${Math.round(Math.abs(worst.meanMs))} ms ${worst.meanMs < 0 ? "early" : "late"} on average.`,
    );
  }
  if (loosest.spreadMs > TIGHT_MS && (measured.length > 1 || lines.length === 0)) {
    lines.push(`${countPlural(loosest)[0].toUpperCase()}${countPlural(loosest).slice(1)} are the least even (±${Math.round(loosest.spreadMs)} ms).`);
  }
  return lines.length > 0 ? lines.join(" ") : "Every count is landing evenly.";
}

function Tick({ hit, ghost }: { hit: Hit; ghost?: boolean }) {
  const offset = Math.max(-1, Math.min(1, hit.errorMs / CELL_SCALE_MS));
  return (
    <span
      className="count__tick"
      data-grade={gradeHit(hit.errorMs)}
      data-ghost={ghost || undefined}
      style={{ left: `${50 + offset * 50}%` }}
    />
  );
}

export function CountView({ session }: { session: TimingSession }) {
  const { hits, subdivision, settings } = session;
  const perBar = subdivision * settings.beatsPerBar;
  const latest = hits.at(-1);
  const bar = latest ? Math.floor(latest.slot / perBar) : 0;
  const bySlot = new Map(hits.map((hit) => [hit.slot, hit]));
  const stats = statsByCount(hits, subdivision);
  const summary = insight(stats);
  const zone = `${50 - (TIGHT_MS / CELL_SCALE_MS) * 50}%`;

  return (
    <section className="card count" aria-label="Timing by count">
      <div className="chart-card__header">
        <h2 className="chart-card__title">Count</h2>
        <p className="count__insight">{summary ?? "Play along and each count fills in"}</p>
      </div>

      <div className="count__scroll">
        <div className="count__lane" data-empty={hits.length === 0} style={{ gridTemplateColumns: `repeat(${perBar}, minmax(38px, 1fr))` }}>
          {Array.from({ length: perBar }, (_, position) => {
            const current = bySlot.get(bar * perBar + position);
            const previous = bySlot.get((bar - 1) * perBar + position);
            const onBeat = position % subdivision === 0;
            const name = countName(position, subdivision, settings.beatsPerBar);
            return (
              <div className="count__cell" key={position} data-beat={onBeat}>
                <span className="count__label">{onBeat ? name : name.split(" ")[1]}</span>
                <div
                  className="count__slot"
                  title={current ? `${name}: ${signed(current.errorMs)} ms` : `${name}: no note`}
                >
                  <span className="count__zone" style={{ left: zone, right: zone }} />
                  <span className="count__line" />
                  {current ? <Tick hit={current} /> : previous && <Tick hit={previous} ghost />}
                </div>
                <span className="count__ms num" data-grade={current ? gradeHit(current.errorMs) : undefined}>
                  {current ? signed(current.errorMs) : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {hits.length > 0 && (
        <div className="count__stats">
          {stats.map((stat) => {
            const measured = stat.count >= MIN_NOTES_PER_COUNT;
            return (
              <div className="count-stat" key={stat.index} data-grade={measured ? gradeHit(stat.meanMs) : undefined}>
                <span className="count-stat__name">{stat.index === 0 ? "Beat" : stat.syllable}</span>
                <span className="count-stat__value num">
                  {measured ? `${signed(stat.meanMs)} ms` : "—"}
                </span>
                <span className="count-stat__meta">
                  {measured
                    ? `${Math.abs(stat.meanMs) <= 3 ? "centred" : stat.meanMs < 0 ? "early" : "late"} · ±${Math.round(stat.spreadMs)} · ${stat.count} notes`
                    : "not enough notes"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
