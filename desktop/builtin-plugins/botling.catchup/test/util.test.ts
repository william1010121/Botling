// The plugin keeps its own copies of a few core helpers (src/util.ts) so it depends only on the plugin
// API; the summary prompt, its cache keys and the CLI's environment must stay exactly the core's.
import { describe, expect, it } from "vitest";
import { isSummaryReply as coreReply } from "../../../src/contract/summary";
import { characterCount as coreCount, characterPrefix as corePrefix } from "../../../src/core/briefing";
import { LANGUAGE_PROMPT_NAMES as coreNames } from "../../../src/core/prompts";
import { fromSwiftDate as coreFrom, toSwiftDate as coreTo } from "../../../src/core/store/records";
import { childEnvironment as coreEnvironment } from "../../../src/core/agent/runner";
import { characterCount, characterPrefix, childEnvironment, fromSwiftDate, isSummaryReply, LANGUAGE_PROMPT_NAMES, toSwiftDate } from "../src/util";

describe("the plugin's copies of core helpers", () => {
  it("say the same as the core's", () => {
    expect(LANGUAGE_PROMPT_NAMES).toEqual(coreNames);
    for (const text of ["", "abc", "👍🏽 family 👨‍👩‍👧 中文", "a b ".repeat(600)]) {
      expect(characterCount(text)).toBe(coreCount(text));
      for (const n of [0, 1, 5, 1_000]) expect(characterPrefix(text, n)).toBe(corePrefix(text, n));
    }
    for (const role of ["bot", "notice", "user", "error", "relay", "divider"]) expect(isSummaryReply({ role })).toBe(coreReply({ role }));
    expect(toSwiftDate(1_800_000_000_000)).toBe(coreTo(1_800_000_000_000));
    expect(fromSwiftDate(800_000_000)).toBe(coreFrom(800_000_000));
    const extra = { CLAUDECODE: "1", FAKE: "x", GONE: undefined };
    const { CCB_PLUGIN_HOST: _host, ...core } = coreEnvironment(extra);
    expect(childEnvironment(extra)).toEqual(core);
  });
});
