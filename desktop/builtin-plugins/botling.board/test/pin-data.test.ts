// What a pin holds in a line, from its data's shape, the chip it shows, and what pins.json's 1.x format falls back to (components.test.ts had these when the core kept pins).
import { describe, expect, it } from "vitest";
import { chip, headline, readPin, short } from "../src/pin-data";

describe("pin data", () => {
  it("say what a pin holds in a line, from its data's shape", () => {
    expect(headline(`{"summary":"All green","x":1}`)).toBe("All green");
    expect(headline(`{"items":[{"title":"a"},{"title":"b"}]}`)).toBe("a · 2");
    expect(headline(`{"cpu":42,"mem":7,"disk":1}`)).toBe("cpu 42 · mem 7");
    expect(headline(`[]`)).toBe("Nothing yet");
    expect(headline(`true`)).toBe("Yes");
    expect(headline("not json\nsecond")).toBe("not json");
    expect(short("a very long status text")).toBe("a very long s…");
    expect(chip(undefined, "x", "failed", true)).toEqual({ text: "Failed", tone: "bad" });
    expect(chip(undefined, "x", "approve", false)).toEqual({ text: "Allow?", tone: "warning" });
    expect(chip({ text: "26°", tone: "good" }, "x", "done", true)).toEqual({ text: "26°", tone: "good" });
    // 1.x's pins.json: old sizes and unknown values fall back; a pin without a command never refreshes.
    expect(readPin({ id: "A", name: "n", data: "1", refresh: "weekly", size: "L", minutes: 0, float: { corner: "x", width: 280, height: 160 } })).toMatchObject({ refresh: "manual", size: "4x2", minutes: 1, float: { corner: "topRight", collapsed: false } });
    expect(readPin({ name: "no id" })).toBeNull();
  });
});
