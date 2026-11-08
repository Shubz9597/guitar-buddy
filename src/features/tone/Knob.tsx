// A drawn amp knob for 0-10 settings, so a recipe reads like an amp's front
// panel: a 270° track, the value arc and a pointer, with the number below.

const SWEEP = 270;
const START = 135; // degrees, measured clockwise from 3 o'clock
const R = 16;
const CIRCUMFERENCE = 2 * Math.PI * R;
const TRACK = (CIRCUMFERENCE * SWEEP) / 360;

export function Knob({ label, value }: { label: string; value: number }) {
  const amount = Math.max(0, Math.min(10, value)) / 10;
  const angle = ((START + SWEEP * amount) * Math.PI) / 180;
  return (
    <figure className="knob" aria-label={`${label}: ${value.toFixed(1)} of 10`}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle className="knob__track" cx="20" cy="20" r={R} strokeDasharray={`${TRACK} ${CIRCUMFERENCE}`} transform={`rotate(${START} 20 20)`} />
        <circle
          className="knob__arc"
          cx="20"
          cy="20"
          r={R}
          strokeDasharray={`${TRACK * amount} ${CIRCUMFERENCE}`}
          transform={`rotate(${START} 20 20)`}
        />
        <circle className="knob__cap" cx="20" cy="20" r="11" />
        <line className="knob__pointer" x1="20" y1="20" x2={20 + 8.5 * Math.cos(angle)} y2={20 + 8.5 * Math.sin(angle)} />
      </svg>
      <figcaption>
        <span className="knob__value">{value.toFixed(1)}</span>
        <span className="knob__label">{label}</span>
      </figcaption>
    </figure>
  );
}
