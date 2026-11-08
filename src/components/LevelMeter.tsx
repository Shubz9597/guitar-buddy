import { useEffect, useState } from "react";
import { audioEngine } from "../audio/engine";

/** Input level from the guitar analyser, on a -60..0 dBFS scale. */
export function LevelMeter({ wide = false }: { wide?: boolean }) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    let decay: number | undefined;
    const unsubscribe = audioEngine.subscribe((message) => {
      if (message.type !== "level") return;
      const db = 20 * Math.log10(Math.max(message.peak, 1e-6));
      setLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
      window.clearTimeout(decay);
      decay = window.setTimeout(() => setLevel(0), 300);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(decay);
    };
  }, []);

  return (
    <span className={`meter ${wide ? "meter--wide" : ""}`} role="meter" aria-label="Input level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span className="meter__fill" style={{ clipPath: `inset(0 ${100 - level * 100}% 0 0)` }} />
    </span>
  );
}
