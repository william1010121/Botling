import { describe, expect, it } from "vitest";
import { subBotRule, workerSubBotRule } from "../../src/core/prompts";

describe.each([["subBotRule", subBotRule, "subagent"], ["workerSubBotRule", workerSubBotRule, "worker"]])("%s for a requested new sub bot", (_name, rule, noun) => {
  it("starts the job first when none is running, then moves it on the next turn", () => {
    expect(rule).toContain(`asks for a sub bot and no ${noun} is running`);
    expect(rule).toContain(`start the ${noun} for the job first`);
    expect(rule).toContain("on your next turn, once it is running");
  });
  it("never silently swaps a requested sub bot for a plain one", () => {
    expect(rule).toContain(`never quietly replace a requested sub bot with a plain ${noun}`);
    expect(rule).toContain("say so");
  });
});
