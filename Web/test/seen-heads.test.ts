import { afterEach, describe, expect, it, vi } from "vitest";
import { animateSeenArrivals, seenHeadsCSS, setSeenHeads } from "../src/heads";
import { seenMarks } from "../src/messages";

afterEach(() => vi.unstubAllGlobals());

describe("seen marks as the heads' tiny characters (Bot look Cute)", () => {
  it("puts each head's image on its mark", () => {
    const css = seenHeadsCSS({ C: "data:image/svg+xml;charset=utf-8,%3Csvg%3E", X: "data:image/svg+xml;charset=utf-8,x" });
    expect(css).toContain(`.seen-mark[data-mark="C"] { background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg%3E"); }`);
    expect(css).toContain(`.seen-mark[data-mark="X"]`);
  });

  it("drops quotes from a URL and skips a mark that is not a letter", () => {
    const css = seenHeadsCSS({ C: 'data:x"); color: red; ("', '"]{}': "data:y" });
    expect(css).not.toContain('"); color');
    expect(css).not.toContain("data:y");
  });

  it("switches every mark on the page, drawn already or not, and back to letters", () => {
    const marks = seenMarks([{ mark: "C", name: "Claude", seen: true }, { mark: "X", name: "Codex", seen: false }]);
    document.body.append(marks);
    expect([...marks.querySelectorAll<HTMLElement>(".seen-mark")].map((mark) => mark.dataset.mark)).toEqual(["C", "X"]);
    setSeenHeads({ C: "data:c", X: "data:x" });
    expect(document.body.classList.contains("seen-heads")).toBe(true);
    expect(document.getElementById("seen-heads-style")?.textContent).toContain("data:c");
    setSeenHeads(null);
    expect(document.body.classList.contains("seen-heads")).toBe(false);
    expect(document.getElementById("seen-heads-style")).toBeNull();
    // The tooltip says who has seen it, as with letters.
    expect(marks.title).toBe("Seen by Claude · not yet by Codex");
  });

  it.each(["claude", "codex", "both"])("keeps %s recipients separate from actual read receipts", (target) => {
    for (const read of [[], ["C"], ["X"], ["C", "X"]]) {
      const heads = [
        { mark: "C", name: "Claude", seen: read.includes("C"), recipient: target !== "codex" },
        { mark: "X", name: "Codex", seen: read.includes("X"), recipient: target !== "claude" },
      ];
      const marks = seenMarks(heads);
      const drawn = [...marks.querySelectorAll<HTMLElement>(".seen-mark")];
      expect(drawn.map((head) => head.classList.contains("recipient"))).toEqual(heads.map((head) => head.recipient));
      expect(drawn.map((head) => head.classList.contains("on"))).toEqual(heads.map((head) => head.seen));
      expect([...marks.querySelectorAll<HTMLElement>(".seen-check")].map((check) => check.dataset.mark)).toEqual(read);
      expect(marks.title).toContain(target === "both" ? "To Claude, Codex" : `To ${target === "claude" ? "Claude" : "Codex"}`);
    }
  });

  it("does not animate arrivals with reduced motion enabled", () => {
    setSeenHeads({ C: "data:c", X: "data:x" });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const row = seenMarks([{ mark: "C", name: "Claude", seen: true, recipient: true }]);
    animateSeenArrivals(row);
    expect(row.querySelectorAll(".head-arrive, .receipt-arrive")).toHaveLength(0);
    setSeenHeads(null);
  });
});
