// Regression: a test run started from a Botling terminal must not see the user's real app data.
import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("has no BOTLING_* app or GIT_* variables inherited from the shell", () => {
    const leaked = Object.keys(process.env).filter((key) => (key.startsWith("BOTLING_") && !key.startsWith("BOTLING_LIVE_")) || key.startsWith("GIT_"));
    expect(leaked).toEqual([]);
  });
});
