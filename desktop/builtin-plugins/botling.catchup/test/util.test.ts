// The plugin keeps its own copy of the one core helper it needs (src/util.ts) so it depends only on the
// plugin API; it must stay exactly the core's.
import { describe, expect, it } from "vitest";
import { isSummaryReply as coreReply } from "../../../src/contract/summary";
import { isSummaryReply } from "../src/util";

describe("the plugin's copy of a core helper", () => {
  it("says the same as the core's", () => {
    for (const role of ["bot", "notice", "user", "error", "relay", "divider"]) expect(isSummaryReply({ role })).toBe(coreReply({ role }));
  });
});
