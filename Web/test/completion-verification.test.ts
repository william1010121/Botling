// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { completionVerificationElement, messageElement } from "../src/messages";
import { setLanguage } from "../src/i18n";
import type { MessageView } from "../src/types";
const message = (completionVerification?: MessageView["completionVerification"]): MessageView => ({
  id: "reply", role: "bot", text: "Actual reply", stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, attachments: null,
  replyTo: null, replyPreview: null, openable: false, completionVerification,
});
describe("actual completion verification", () => {
  it.each([undefined, "botling · Codex"])("places a thumbs-only passed disclosure with reply actions (%s)", (speaker) => {
    setLanguage("en");
    const row = messageElement({ ...message({ model: "actual-model", state: "judged", verdict: "COMPLETE", reason: "Checks passed" }),
      speaker, reactionEnabled: true, tasks: [{ id: "work", name: "Work", kind: "command", status: "completed", label: "Work" }],
      seen: [{ name: "Codex", mark: "X", seen: true }],
    }, {});
    const footer = row.querySelector(".message-footer")!;
    const card = footer.querySelector<HTMLDetailsElement>(".completion-verification")!;
    expect(card, "verification belongs to the same footer as reactions/read heads").not.toBeNull();
    expect(footer.querySelector(".task-summary")).not.toBeNull();
    expect(footer.querySelector(".reactions")).not.toBeNull();
    expect(footer.querySelector(".seen-marks")).not.toBeNull();
    expect(row.querySelectorAll(".completion-verification")).toHaveLength(1);
    const summary = card.querySelector("summary")!;
    expect(summary.textContent).toBe("👍");
    expect(summary.getAttribute("aria-label")).toBe("Completion verification · Completed");
    expect(summary.title).toBe("Completion verification · Completed");
    expect(card.open).toBe(false);
    const before = sent.length;
    summary.click();
    expect(card.open).toBe(true);
    expect(card.querySelector(".verification-details")?.textContent).toContain("Completion verification · Completed");
    expect(card.querySelector(".verification-model")?.textContent).toBe("actual-model · medium");
    expect(card.querySelector(".verification-reason")?.textContent).toBe("Checks passed");
    expect(sent.length).toBe(before); // Viewing verification must not post a reaction.
  });
  it("shows only a thumb for a genuine passed verdict", () => {
    const card = completionVerificationElement({ model: "actual", state: "judged", verdict: "COMPLETE" });
    expect(card.querySelector("summary")?.textContent).toBe("👍");
  });
  it("creates an action footer even without reactions, tasks, or read heads", () => {
    const row = messageElement(message({ model: "actual", state: "checking" }), {});
    expect(row.querySelector(".message-footer > .completion-verification")).not.toBeNull();
  });
  it.each([
    { state: "checking", verdict: "COMPLETE" }, { state: "interrupted", verdict: "COMPLETE" },
    { state: "judged", verdict: null }, { state: "judged", verdict: "UNKNOWN" },
    { state: "judged", verdict: "UNAVAILABLE" }, { state: "judged", verdict: "CONTINUE" },
    { state: "judged", verdict: "COMPLETE", continuationPaused: true },
  ] as const)("never shows a success thumb for unfinished or unknown records: %j", (record) => {
    expect(completionVerificationElement({ model: "actual", ...record }).querySelector("summary")?.textContent).not.toContain("👍");
  });
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
    expect((card as HTMLDetailsElement).open).toBe(false);
    expect(card.querySelector("summary .verification-status")?.textContent).toBeTruthy();
    expect(card.querySelector("summary")?.textContent).not.toContain(reason);
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
    expect(summary.getAttribute("aria-label")).toContain("Completion verification · ");
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
