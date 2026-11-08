import { ResetIcon } from "../../components/icons";
import { countName, gradeHit, LOOSE_MS, TIGHT_MS } from "./analysis";
import type { TimingSession } from "./useTimingSession";

const SLOTS = 48;
const GRADE_COLORS = { tight: "var(--tight)", close: "var(--close)", off: "var(--off)" };

export function HitChart({ session }: { session: TimingSession }) {
  const { hits, settings, subdivision, running } = session;
  const visible = hits.slice(-SLOTS);
  const largest = Math.max(0, ...visible.map((hit) => Math.abs(hit.errorMs)));
  const range = largest > 80 ? 150 : 80;
  // y in viewBox units: 0 (late edge) .. 200 (early edge), 100 = on the beat.
  const y = (errorMs: number) => 100 - (Math.max(-range, Math.min(range, errorMs)) / range) * 100;
  const width = 1000 / SLOTS;
  const ticks = range > 80 ? [100, LOOSE_MS, 0, -LOOSE_MS, -100] : [LOOSE_MS, TIGHT_MS, 0, -TIGHT_MS, -LOOSE_MS];

  return (
    <section className="card chart-card" aria-label="Note timing">
      <div className="chart-card__header">
        <h2 className="chart-card__title">Note timing</h2>
        <div className="chart-card__tools">
          {hits.length > 0 && (
            <button type="button" className="button button--ghost" onClick={session.clear}>
              <ResetIcon />
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="chart">
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden>
          <rect x="0" y={y(TIGHT_MS)} width="1000" height={y(-TIGHT_MS) - y(TIGHT_MS)} fill="var(--tight-soft)" opacity={visible.length === 0 ? 0.45 : 1} />
          {[LOOSE_MS, -LOOSE_MS].map((tick) => (
            <line key={tick} x1="0" x2="1000" y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1="0" x2="1000" y1="100" y2="100" stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />
          {visible.map((hit, index) => {
            const slot = SLOTS - visible.length + index;
            const top = Math.min(y(hit.errorMs), 100);
            const height = Math.max(Math.abs(y(hit.errorMs) - 100), 1.5);
            const latest = index === visible.length - 1;
            return (
              <rect
                key={hit.timeMs}
                x={slot * width + width * 0.2}
                width={width * 0.6}
                y={top}
                height={height}
                rx="2"
                fill={GRADE_COLORS[gradeHit(hit.errorMs)]}
                opacity={latest ? 1 : 0.35 + (0.5 * index) / visible.length}
              >
                <title>{`${countName(hit.slot, subdivision, settings.beatsPerBar)}: ${Math.round(hit.errorMs)} ms`}</title>
              </rect>
            );
          })}
        </svg>
        {ticks.map((tick) => (
          <span key={tick} className="chart__axis num" style={{ top: `${y(tick) / 2}%` }}>
            {tick === 0 ? "0" : `${tick > 0 ? "+" : "−"}${Math.abs(tick)}`}
          </span>
        ))}
        <span className="chart__unit">ms</span>
        <span className="chart__band" style={{ top: `${y(TIGHT_MS) / 2}%` }}>
          ±{TIGHT_MS} ms target
        </span>
        <span className="chart__side" style={{ top: 8 }}>
          Late ↑
        </span>
        <span className="chart__side" style={{ bottom: 8 }}>
          Early ↓
        </span>
        {visible.length === 0 && (
          <div className="chart__empty">
            <span>{running ? "Play along. Each note shows up here." : "Your notes will show up here"}</span>
          </div>
        )}
      </div>
    </section>
  );
}
