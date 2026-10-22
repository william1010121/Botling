import { describe, expect, it } from "vitest";
import { answerPrefix } from "../src/composer";

const answer = { options: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "both", label: "Both" }], chosen: "claude" };

describe("@codex at the start of a message in a bot with two heads", () => {
  it("picks that head and leaves the words", () => {
    expect(answerPrefix("@codex review PR #5", answer)).toEqual({ id: "codex", rest: "review PR #5" });
    expect(answerPrefix("  @Both which is better?", answer)).toEqual({ id: "both", rest: "which is better?" });
  });

  it("leaves other @names and mid-sentence mentions alone", () => {
    expect(answerPrefix("@Gemini hi", answer)).toBeNull();
    expect(answerPrefix("ask @codex later", answer)).toBeNull();
    expect(answerPrefix("@codex", answer)).toBeNull();
  });
});
