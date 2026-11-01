import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { FOLD_AFTER, isLongUserText, resetUserFolds, settleUserFold, visualLines } from "../src/long-message";
import { messageElement } from "../src/messages";
import type { MessageView } from "../src/types";

const message = (extra: Partial<MessageView> = {}): MessageView => ({
  id: "long-1", role: "user", text: "Short.", stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, attachments: null,
  replyTo: null, replyPreview: null, openable: false, reactionEnabled: false,
  ...extra,
});
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
beforeEach(resetUserFolds);

describe("visualLines", () => {
  it("counts line breaks, and long lines as the lines they wrap to", () => {
    expect(visualLines("one")).toBe(1);
    expect(visualLines(lines(5))).toBe(5);
    expect(visualLines("a\n\nb")).toBe(3);
    expect(visualLines("a".repeat(56))).toBe(1);
    expect(visualLines("a".repeat(57))).toBe(2);
  });
  it("counts wide (CJK) characters as two", () => {
    expect(visualLines("字".repeat(28))).toBe(1);
    expect(visualLines("字".repeat(29))).toBe(2);
  });
  it("is long only past the fold by a few lines", () => {
    expect(isLongUserText(lines(FOLD_AFTER))).toBe(false);
    expect(isLongUserText(lines(12))).toBe(false);
    expect(isLongUserText(lines(13))).toBe(true);
    expect(isLongUserText("a".repeat(400))).toBe(false);
    expect(isLongUserText("字".repeat(400))).toBe(true);
    expect(isLongUserText("a".repeat(2000))).toBe(true);
  });
});

describe("a long message of yours", () => {
  const text = lines(30);

  it("is drawn folded, whole in the page, with a centered toggle under it", () => {
    const row = messageElement(message({ text }), {});
    const fold = row.querySelector(".user-body > .user-fold")!;
    expect(fold).not.toBeNull();
    const bubble = fold.querySelector(".user-bubble")!;
    expect(bubble.classList.contains("collapsed")).toBe(true);
    // Every word is still there, so selecting and copying keep working.
    expect(bubble.textContent).toBe(text.replace(/\n/g, ""));
    expect(bubble.querySelectorAll("br")).toHaveLength(29);
    const toggle = fold.querySelector<HTMLButtonElement>(":scope > button.user-fold-toggle")!;
    expect(fold.lastElementChild).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show more");
  });

  it("opens and folds again with the same control", () => {
    const row = messageElement(message({ text }), {});
    const bubble = row.querySelector(".user-bubble")!;
    const toggle = row.querySelector<HTMLButtonElement>(".user-fold-toggle")!;
    toggle.click();
    expect(bubble.classList.contains("collapsed")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show less");
    toggle.click();
    expect(bubble.classList.contains("collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show more");
  });

  it("stays open when the chat redraws it, per message", () => {
    messageElement(message({ text }), {}).querySelector<HTMLButtonElement>(".user-fold-toggle")!.click();
    expect(messageElement(message({ text }), {}).querySelector(".user-bubble")!.classList.contains("collapsed")).toBe(false);
    expect(messageElement(message({ id: "long-2", text }), {}).querySelector(".user-bubble")!.classList.contains("collapsed")).toBe(true);
  });

  it("keeps attachments and a pasted chip outside the fold", () => {
    const attachments: MessageView["attachments"] = [{ name: "a.png", kind: "image", url: "file:///tmp/a.png" }];
    const row = messageElement(message({ text: `${text}\n\n<pasted-text>\nlog\n</pasted-text>`, attachments }), {});
    const body = row.querySelector(".user-body")!;
    const strips = body.querySelectorAll(":scope > .attachments");
    expect(strips).toHaveLength(2);
    expect(body.querySelector(".user-fold .attachments")).toBeNull();
    expect(body.querySelector(".user-fold .paste-chip")).toBeNull();
  });

  it("unfolds for good when the page shows it all anyway", () => {
    const row = messageElement(message({ text }), {});
    const fold = row.querySelector<HTMLElement>(".user-fold")!;
    const bubble = fold.querySelector<HTMLElement>(".user-bubble")!;
    // jsdom measures nothing (0): keep the fold.
    settleUserFold(fold);
    expect(bubble.classList.contains("collapsed")).toBe(true);
    Object.defineProperty(bubble, "scrollHeight", { value: 200 });
    Object.defineProperty(bubble, "clientHeight", { value: 200 });
    settleUserFold(fold);
    expect(bubble.classList.contains("collapsed")).toBe(false);
    expect(fold.querySelector(".user-fold-toggle")).toBeNull();
  });
});

describe("other messages", () => {
  it("a short message of yours is drawn as before", () => {
    const row = messageElement(message({ text: "Hello\nthere" }), {});
    expect(row.querySelector(".user-fold, .user-fold-toggle, .collapsed")).toBeNull();
    expect(row.querySelector(".user-body > .user-bubble")?.innerHTML).toBe("Hello<br>there");
  });
  it("a long bot reply is not folded", () => {
    const row = messageElement(message({ role: "bot", text: lines(30) }), {});
    expect(row.querySelector(".user-fold, .user-fold-toggle")).toBeNull();
  });
});

// jsdom cannot lay out; these rules carry the look.
it("folds to about ten lines with a fade, the toggle centered in the existing fold style", () => {
  const css = readFileSync(`${__dirname}/../src/chat.css`, "utf8");
  const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".user-fold")).toMatch(/align-items: center/);
  expect(rule(".user-bubble.collapsed")).toMatch(/max-height: calc\(1\.65em \* 10/);
  expect(rule(".user-bubble.collapsed")).toMatch(/overflow: hidden/);
  // The fade sits on the bubble (its shape stays whole) and lets clicks and selection through.
  expect(rule(".user-bubble.collapsed::after")).toMatch(/linear-gradient\(to bottom, transparent, var\(--user-bubble\)\)/);
  expect(rule(".user-bubble.collapsed::after")).toMatch(/pointer-events: none/);
  expect(rule(".user-fold > .fold")).toMatch(/align-self: center/);
});
