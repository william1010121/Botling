import { beforeEach, describe, expect, it } from "vitest";
import { messageElement } from "../src/messages";
import { sent } from "../src/bridge";
import { setLanguage } from "../src/i18n";
import type { MessageView } from "../src/types";
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const question = (extra: Partial<MessageView> = {}): MessageView => ({ id: "q1", role: "bot", text: "Proceed?", stamp: null, avatar: null,
  choices: [{ label: "Yes", detail: null, recommended: true, action: null }], chosen: null, answer: null, open: true, canIgnoreQuestion: true,
  attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra });
beforeEach(() => { sent.length = 0; document.body.innerHTML = ""; setLanguage("en"); });
describe("app-owned question Ignore", () => {
  it("is a focusable native button emitting only dismissal; existing answer works", () => {
    const row = messageElement(question(), {}); document.body.append(row);
    const ignore = row.querySelector<HTMLButtonElement>(".question-ignore")!;
    expect(ignore.type).toBe("button"); expect(ignore.tabIndex).toBe(0);
    ignore.focus(); expect(document.activeElement).toBe(ignore);
    ignore.click(); ignore.click();
    expect(sent).toEqual([{ type: "ignoreQuestion", messageID: "q1" }, { type: "ignoreQuestion", messageID: "q1" }]);
    sent.length = 0;
    [...row.querySelectorAll("button")].find(button => button.textContent?.includes("Yes"))!.click();
    expect(sent).toEqual([{ type: "choose", messageID: "q1", index: 0 }]);
  });
  it("shows original options as noninteractive information after dismissal", () => {
    const row = messageElement(question({ ignoredAt: "2026-10-29T00:00:00.000Z", open: false }), {});
    expect(row.querySelector(".ignored-question summary")?.textContent).toBe("Notification · ignored, not answered");
    expect(row.querySelector(".ignored-question li")?.textContent).toBe("Yes");
    expect(row.querySelector(".question-ignore")).toBeNull();
    expect(row.querySelector(".ignored-question button, .ignored-question iframe")).toBeNull();
    expect(sent).toEqual([]);
  });
  it("does not offer Ignore for older hosts, approvals or answered questions", () => {
    for (const extra of [{ canIgnoreQuestion: undefined }, { canIgnoreQuestion: false }, { open: false, chosen: 0 }])
      expect(messageElement(question(extra), {}).querySelector(".question-ignore")).toBeNull();
  });
});
