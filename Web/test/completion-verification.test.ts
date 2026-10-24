// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { completionVerificationElement, messageElement } from "../src/messages";
import { setLanguage } from "../src/i18n";
import type { MessageView } from "../src/types";
const message = (completionVerification?: MessageView["completionVerification"]): MessageView => ({
  id: "reply", role: "bot", text: "Actual reply", stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, attachments: null,
  replyTo: null, replyPreview: null, openable: false, completionVerification,
});
describe("actual completion verification", () => {
  it("attaches checking status to the reply; legacy replies have no fabricated status", () => {
    setLanguage("en");
    expect(messageElement(message(), {}).querySelector(".completion-verification")).toBeNull();
    const row = messageElement(message({ model: "gpt-6-luna", state: "checking" }), {});
    expect(row.querySelector(".bot-column .completion-verification")?.textContent).toContain("Checking…");
    expect(row.textContent).toContain("gpt-6-luna · medium");
    expect(row.querySelector('[role="status"]')).not.toBeNull();
  });
  it.each(["CONTINUE", "CONTINUE_ANALYSIS", "COMPLETE", "NEEDS_TERMINAL_SIGNAL", "WAITING_USER", "CANCELLED", "WAITING_DEPENDENCY", "UNKNOWN", "UNAVAILABLE"] as const)("renders %s and the real reason safely", (verdict) => {
    setLanguage("en");
    const reason = '<img src=x onerror="alert(1)"> Real evidence';
    const card = completionVerificationElement({ model: "actual-model", state: "judged", verdict, reason });
    expect(card.dataset.verdict).toBe(verdict);
    expect(card.textContent).toContain(reason);
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).toContain("actual-model");
    if (verdict !== "COMPLETE") expect(card.querySelector(".verification-title")?.textContent).not.toContain("Completed");
  });
  it.each(["checking", "interrupted", "judged"] as const)("starts %s collapsed with a native keyboard disclosure", (state) => {
    setLanguage("en");
    const card = completionVerificationElement({ model: "gpt-6-luna", state, verdict: "WAITING_DEPENDENCY", reason: "Worker report pending" });
    expect(card.tagName).toBe("DETAILS");
    const details = card as HTMLDetailsElement;
    const summary = details.querySelector("summary")!;
    expect(summary).not.toBeNull();
    expect(details.open).toBe(false);
    expect(summary.textContent).toContain("Completion verification · ");
    expect(summary.textContent).not.toContain("gpt-6-luna");
    expect(summary.textContent).not.toContain("Worker report pending");
    summary.click();
    expect(details.open).toBe(true);
    expect(details.querySelector(".verification-model")?.textContent).toBe("gpt-6-luna · medium");
    if (state === "judged") expect(details.querySelector(".verification-reason")?.textContent).toBe("Worker report pending");
    summary.click();
    expect(details.open).toBe(false);
  });
  it("shows interrupted and bounded-wake pause as unfinished", () => {
    setLanguage("zh-Hant");
    expect(completionVerificationElement({ model: "actual", state: "interrupted" }).textContent).toContain("已中斷；未有判定");
    expect(completionVerificationElement({ model: "actual", state: "judged", verdict: "CONTINUE", reason: "尚未分析", continuationPaused: true }).textContent).toContain("工作仍未完成");
    setLanguage("en");
  });
});
