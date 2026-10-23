/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { messageElement } from "../src/messages";
import type { MessageView } from "../src/types";

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("a turn cut off before it answered", () => {
  it("keeps its words and steps, and says it was interrupted", () => {
    const row = messageElement(message({
      text: "Found it: the bug is in",
      interrupted: true,
      steps: [{ id: "t1", kind: "tool", tool: "Read", title: "Read main.swift", detail: "main.swift", output: "print(1)", failed: false, done: true, status: null, count: null }],
    }), {});
    expect(row.querySelector(".markdown")?.textContent).toContain("Found it: the bug is in");
    expect(row.querySelector(".steps, .steps-line, [class*=step]")).not.toBeNull();
    const note = row.querySelector(".interrupted-note");
    expect(note?.textContent).toBe("Interrupted");
  });

  it("draws only its steps when it had not said anything yet", () => {
    const row = messageElement(message({
      interrupted: true,
      steps: [{ id: "t1", kind: "tool", tool: "Read", title: "Read main.swift", detail: "main.swift", output: null, failed: false, done: true, status: null, count: null }],
    }), {});
    expect(row.querySelector(".interrupted-note")).not.toBeNull();
  });

  it("a finished reply says nothing of the kind", () => {
    expect(messageElement(message({ text: "Done" }), {}).querySelector(".interrupted-note")).toBeNull();
  });
});
