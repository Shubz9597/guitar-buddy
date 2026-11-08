import { useCallback, useState } from "react";

function read<T>(key: string, fallback: T, sanitize: (value: unknown) => T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : sanitize(JSON.parse(stored));
  } catch {
    return fallback;
  }
}

/** useState that survives reloads. `sanitize` repairs stored values from older versions. */
export function usePersistentState<T>(key: string, fallback: T, sanitize: (value: unknown) => T) {
  const [value, setValue] = useState(() => read(key, fallback, sanitize));
  const update = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Storage can be unavailable (private mode); settings then last for the session.
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, update] as const;
}
