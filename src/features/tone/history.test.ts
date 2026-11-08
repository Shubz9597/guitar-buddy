import { describe, expect, it } from "vitest";
import { addHistory, formatDuration, groupByDay, HISTORY_LIMIT, type HistoryEntry } from "./history.ts";

const entry = (id: string, startedAt: number): HistoryEntry => ({
  id,
  song: { id: `s-${id}`, title: `Song ${id}`, artist: "Artist" },
  startedAt,
  seconds: 90,
  searches: 6,
  outcome: "saved",
});

describe("tone history", () => {
  it("puts new searches first, replaces the same id and keeps a limit", () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) list = addHistory(list, entry(String(i), i));
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0].id).toBe(String(HISTORY_LIMIT + 4));
    list = addHistory(list, { ...entry("10", 999), outcome: "failed" });
    expect(list[0]).toMatchObject({ id: "10", outcome: "failed" });
    expect(list.filter((e) => e.id === "10")).toHaveLength(1);
  });

  it("groups by day as today, yesterday, then dates", () => {
    const now = new Date(2026, 10, 7, 15, 0).getTime();
    const groups = groupByDay(
      [entry("a", new Date(2026, 10, 7, 9).getTime()), entry("b", new Date(2026, 10, 7, 1).getTime()), entry("c", new Date(2026, 10, 6, 23).getTime()), entry("d", new Date(2026, 10, 2, 12).getTime())],
      now,
    );
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [expect.stringMatching(/2/), ["d"]],
    ]);
  });

  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(134)).toBe("2:14");
  });
});
