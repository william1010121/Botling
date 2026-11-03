// ADR-006 M4: the anti-nag rules for <suggest-component>, without a core.
import { describe, expect, it } from "vitest";
import { findExisting, judgeSuggestion, MIN_DRAFT, type SuggestionInput } from "../../src/core/suggestion-rules";

const base: SuggestionInput = {
  name: "disk-usage", draft: "how full the disk is, from df -h", libraryNames: ["git-status", "choices"], botNames: ["choices"], suggestionsThisTurn: 0, undoneNames: [],
};

describe("suggestion rules", () => {
  it("allows a new, repeatable need", () => {
    expect(judgeSuggestion(base)).toEqual({ allow: true });
  });

  it("looks up what exists first: offers a library component the bot lacks, drops one it already has", () => {
    expect(judgeSuggestion({ ...base, name: "git-status" })).toEqual({ allow: true, existing: "git-status" });
    expect(judgeSuggestion({ ...base, name: "git-status", botNames: ["git-status"] })).toEqual({ allow: false, reason: "already-has" });
    // A bot with no list uses the whole library.
    expect(judgeSuggestion({ ...base, name: "git-status", botNames: null })).toEqual({ allow: false, reason: "already-has" });
    expect(judgeSuggestion({ ...base, name: "status-git" })).toEqual({ allow: true, existing: "git-status" });
    expect(judgeSuggestion({ ...base, name: "git-status-card" })).toEqual({ allow: true, existing: "git-status" });
  });

  it("finds similar names without matching on one shared word", () => {
    expect(findExisting("disk-usage", ["disk-health"])).toBeUndefined();
    expect(findExisting("usage", ["disk-usage"])).toBeUndefined();
    expect(findExisting("disk-usage-chart", ["disk-usage"])).toBe("disk-usage");
    expect(findExisting("x", [])).toBeUndefined();
  });

  it("gives no card for one-shot output", () => {
    expect(judgeSuggestion({ ...base, draft: "" })).toEqual({ allow: false, reason: "one-shot" });
    expect(judgeSuggestion({ ...base, draft: "x".repeat(MIN_DRAFT - 1) })).toEqual({ allow: false, reason: "one-shot" });
    expect(judgeSuggestion({ ...base, draft: "a one-off table of this week's invoices" })).toEqual({ allow: false, reason: "one-shot" });
    expect(judgeSuggestion({ ...base, draft: "只是這份報告的一次性整理，不會再用" })).toEqual({ allow: false, reason: "one-shot" });
    expect(judgeSuggestion({ ...base, draft: "just this once, the totals" })).toEqual({ allow: false, reason: "one-shot" });
  });

  it("allows at most one card per turn, and not again what the user took back", () => {
    expect(judgeSuggestion({ ...base, suggestionsThisTurn: 1 })).toEqual({ allow: false, reason: "one-per-turn" });
    expect(judgeSuggestion({ ...base, undoneNames: ["disk-usage"] })).toEqual({ allow: false, reason: "undone" });
    expect(judgeSuggestion({ ...base, name: "" })).toEqual({ allow: false, reason: "invalid" });
  });
});
