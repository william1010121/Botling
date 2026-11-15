// envCount (test/helpers.ts): the run and seed counts CI lowers on pull requests; anything odd keeps the default.
import { afterEach, describe, expect, it } from "vitest";
import { envCount } from "../helpers";

const NAME = "ENV_COUNT_TEST_KNOB";
afterEach(() => { delete process.env[NAME]; });

describe("envCount", () => {
  it("unset or empty gives the default", () => {
    expect(envCount(NAME, 30)).toBe(30);
    process.env[NAME] = "";
    expect(envCount(NAME, 30)).toBe(30);
  });

  it("a positive whole number is used", () => {
    process.env[NAME] = "2";
    expect(envCount(NAME, 30)).toBe(2);
  });

  it("zero, negative, fractional or non-numeric values give the default", () => {
    for (const value of ["0", "-3", "1.5", "abc", " ", "Infinity"]) {
      process.env[NAME] = value;
      expect(envCount(NAME, 30), value).toBe(30);
    }
  });
});
