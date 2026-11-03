import { describe, expect, it } from "vitest";
import { buildRequest, PLUGIN_STARTERS } from "../../src/renderer/plugin-starters";

describe("Plugins page: Ask Maintainer to build (ADR-006 M5)", () => {
  it("sends nothing for an empty description or an untouched template", () => {
    expect(buildRequest("   ")).toBeNull();
    for (const starter of PLUGIN_STARTERS) expect(buildRequest(starter.text)).toBeNull();
  });
  it("turns a description into a build request for Maintainer", () => {
    expect(buildRequest("a clock")).toBe("Build a plugin: a clock");
    const starter = PLUGIN_STARTERS[0];
    expect(buildRequest(`${starter.text}today's calendar`)).toBe(`${starter.text}today's calendar`);
  });
  it("has unique starter ids", () => {
    expect(new Set(PLUGIN_STARTERS.map((starter) => starter.id)).size).toBe(PLUGIN_STARTERS.length);
  });
});
