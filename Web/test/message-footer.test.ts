import { readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { messageElement } from "../src/messages";
import { resetTaskChips } from "../src/tasks";
import type { MessageView } from "../src/types";

const message = (extra: Partial<MessageView> = {}): MessageView => ({
  id: "footer-reply", role: "bot", text: "Finished.", stamp: null, avatar: null,
  choices: null, chosen: null, answer: null, open: false, attachments: null,
  replyTo: null, replyPreview: null, openable: false, reactionEnabled: true,
  tasks: [{ id: "done", kind: "command", title: "Build", status: "completed", started: 0, ended: 1000, detail: null }],
  seen: [{ mark: "C", name: "Claude", seen: true }, { mark: "X", name: "Codex", seen: false }],
  ...extra,
});
beforeEach(resetTaskChips);

it("places work status, reaction controls and head receipts in one footer outside the bubble", () => {
  const row = messageElement(message(), {});
  const footer = row.querySelector(".message-footer")!;
  expect(footer).not.toBeNull();
  expect([...footer.children].map(node => node.className)).toEqual(["task-chips", "reactions", "seen-marks"]);
  expect(footer.closest(".bubble")).toBeNull();
  expect(footer.parentElement?.lastElementChild).toBe(footer);
});

it.each(["user", "bot", "notice", "relay", "error"] as const)("keeps %s metadata together when work status is absent", role => {
  const row = messageElement(message({ role, tasks: null }), {});
  expect(row.querySelector(".message-footer > .reactions + .seen-marks")).not.toBeNull();
  expect(row.querySelector(".message-footer")?.closest(".bubble")).toBeNull();
});

it("omits absent groups and an entirely empty footer", () => {
  for (const extra of [
    { tasks: null, seen: null },
    { tasks: null, reactionEnabled: false },
    { seen: null, reactionEnabled: false },
  ]) {
    const row = messageElement(message(extra), {});
    expect(row.querySelector(".message-footer")?.children).toHaveLength(1);
  }
  expect(messageElement(message({ tasks: null, seen: null, reactionEnabled: false }), {}).querySelector(".message-footer")).toBeNull();
});

// jsdom cannot measure geometry. These constraints accompany browser measurements at 640/320px.
it("allows compact centered metadata to wrap and gives expanded work details their own line", () => {
  const css = readFileSync(`${__dirname}/../src/chat.css`, "utf8");
  const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".message-footer")).toMatch(/display: flex/);
  expect(rule(".message-footer")).toMatch(/flex-wrap: wrap/);
  expect(rule(".message-footer")).toMatch(/align-items: center/);
  expect(rule(".message-footer")).toMatch(/min-width: 0/);
  expect(rule(".message-footer > .task-chips")).toMatch(/display: contents/);
  expect(rule(".message-footer .task-list, .message-footer .task-output")).toMatch(/flex-basis: 100%/);
  expect(rule(".message-footer > .seen-marks")).toMatch(/margin-top: 0/);
});
