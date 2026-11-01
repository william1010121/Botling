import { describe, expect, it } from "vitest";
import { subBotRule, workerSubBotRule } from "../../src/core/prompts";

describe.each([["subBotRule", subBotRule, "subagent"], ["workerSubBotRule", workerSubBotRule, "worker"]])("%s for a requested new sub bot", (_name, rule, noun) => {
  it("offers a direct sub bot with its first task inside the tag, and moves a running one when it already does the job", () => {
    expect(rule).toContain(`new, empty sub bot directly, with no ${noun} behind it`);
    expect(rule).toContain('<sub-bot name="short name, no quotes">the first task');
    expect(rule).toContain("nothing is started or moved first");
    expect(rule).toContain(`a ${noun} already does that job, move that ${noun}`);
    expect(rule).not.toContain("start the " + noun + " for the job first");
  });
  it("never silently swaps a requested sub bot for a plain one", () => {
    expect(rule).toContain(`Never quietly replace a requested sub bot with a plain ${noun}`);
    expect(rule).toContain("say so");
  });
});
