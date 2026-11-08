import { useState, type ComponentType } from "react";
import { PickLogo } from "./components/icons";
import { TimingTrainer } from "./features/timing/TimingTrainer";
import { ToneSearch } from "./features/tone/ToneSearch";

interface Tool {
  id: string;
  name: string;
  Component: ComponentType;
}

// Each practice tool is a self-contained feature; add new ones here.
const TOOLS: Tool[] = [
  { id: "timing", name: "Timing", Component: TimingTrainer },
  { id: "tone", name: "Tone", Component: ToneSearch },
];

export function App() {
  const [activeId, setActiveId] = useState(TOOLS[0].id);
  const active = TOOLS.find((tool) => tool.id === activeId) ?? TOOLS[0];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <PickLogo />
          Guitar Buddy
        </div>
        <nav className="nav" aria-label="Tools">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="nav__item"
              aria-current={tool.id === active.id ? "page" : undefined}
              onClick={() => setActiveId(tool.id)}
            >
              {tool.name}
            </button>
          ))}
        </nav>
      </header>
      <active.Component />
    </div>
  );
}
