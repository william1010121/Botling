import { beforeEach, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import type { MessageView } from "../src/types";
const message = (extra: Partial<MessageView> = {}): MessageView => ({
  id: "E2A2EE25-7C4A-4EF2-AD52-6B471550ED00", role: "bot", text: "Saved message", stamp: null,
  avatar: null, choices: null, chosen: null, answer: null, open: false, attachments: null,
  replyTo: null, replyPreview: null, openable: false, reactionEnabled: true, ...extra,
});
beforeEach(() => { sent.length = 0; });
it("groups actors and removes only the user's reaction via an explicit set", () => {
  const row = messageElement(message({ reactions: [{ emoji: "👍", actors: ["You", "Codex"], own: true }] }), {});
  const chip = row.querySelector<HTMLButtonElement>(".reaction-chip")!;
  expect(chip.textContent).toBe("👍 2");
  expect(chip.title).toContain("Codex");
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  chip.click();
  expect(sent).toEqual([{ type: "setReaction", messageID: message().id, emoji: "👍", present: false }]);
});
it("adds own reaction to an AI chip and offers a native keyboard palette", () => {
  const row = messageElement(message({ reactions: [{ emoji: "👀", actors: ["Claude"], own: false }] }), {});
  row.querySelector<HTMLButtonElement>(".reaction-chip")!.click();
  expect(sent[0]).toMatchObject({ type: "setReaction", emoji: "👀", present: true });
  expect(row.querySelector("summary")?.getAttribute("aria-label")).toBe("Add reaction");
  expect(row.querySelectorAll(".reaction-palette button")).toHaveLength(6);
  row.querySelector<HTMLButtonElement>(".reaction-palette button")!.click();
  expect(sent[1]).toMatchObject({ type: "setReaction", emoji: "👍", present: true });
  expect(row.querySelector("details")?.open).toBe(false);
});
it("supports saved roles without putting controls inside bubbles; excludes synthetic lines", () => {
  for (const role of ["user", "bot", "notice", "relay", "error"] as const) {
    const row = messageElement(message({ role }), {});
    expect(row.querySelectorAll(".reactions")).toHaveLength(1);
    expect(row.querySelector(".reactions")?.closest(".bubble")).toBeNull();
  }
  expect(messageElement(message({ reactionEnabled: false }), {}).querySelector(".reactions")).toBeNull();
  expect(messageElement(message({ reactionEnabled: undefined }), {}).querySelector(".reactions")).toBeNull();
});
