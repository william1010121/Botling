// Startup timing lines (core/phase-marks.ts): one line per phase, the slowest few of many, nothing without an `out`.
import { describe, expect, it } from "vitest";
import { PhaseMarks, Slowest } from "../../src/core/phase-marks";

describe("PhaseMarks", () => {
  it("writes one line per lap with the time since the previous lap, and a total", () => {
    let t = 1_000;
    const lines: string[] = [];
    const marks = new PhaseMarks((line) => lines.push(line), "core construct", () => t);
    t += 120; expect(marks.lap("library")).toBe(120);
    t += 2_500.4; expect(marks.lap("68 bots")).toBe(2_500);
    marks.total("constructor total");
    expect(lines).toEqual([
      "timing: core construct: library 120 ms",
      "timing: core construct: 68 bots 2500 ms",
      "timing: core construct: constructor total 2620 ms",
    ]);
  });

  it("without an out it only counts (nothing is written, the lap still answers)", () => {
    let t = 0;
    const marks = new PhaseMarks(undefined, "x", () => t);
    t = 40;
    expect(marks.lap("a")).toBe(40);
  });
});

describe("Slowest", () => {
  it("keeps only the 5 slowest, slowest first, with the count it was told about", () => {
    const slow = new Slowest(5);
    [["a", 10], ["b", 90], ["c", 5], ["d", 40], ["e", 70], ["f", 20], ["g", 60]].forEach(([name, ms]) => slow.add(name as string, ms as number));
    expect(slow.line(7)).toBe('5 slowest of 7: "b" 90 ms, "e" 70 ms, "g" 60 ms, "d" 40 ms, "f" 20 ms');
  });

  it("a bot name is one clean quoted line: control characters are escaped and a long name is cut", () => {
    const slow = new Slowest();
    slow.add("evil\nname\u001b[31m", 5);
    slow.add("x".repeat(100), 4);
    const line = slow.line(2);
    expect(line).not.toMatch(/[\n\u001b]/);
    expect(line).toContain('"evil\\nname\\u001b[31m" 5 ms');
    expect(line).toContain(`"${"x".repeat(40)}" 4 ms`);
  });
});
