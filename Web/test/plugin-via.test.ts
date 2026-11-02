/// <reference types="node" />
// A user line a plugin sent (`bots.send`, plan M5) says so above its bubble; your own lines do not.
import { beforeEach, describe, expect, it } from "vitest";
import { messageElement } from "../src/messages";
import type { MessageView } from "../src/types";

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "user", text: "site is down", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("a line a plugin sent", () => {
  it("names the plugin above the bubble", () => {
    const row = messageElement(message({ via: "Uptime" }), {});
    expect(row.querySelector(".speaker.via")?.textContent).toBe("Sent by the plugin Uptime");
    expect(row.querySelector(".user-bubble")?.textContent).toBe("site is down");
  });

  it("your own line has no such label", () => {
    expect(messageElement(message({}), {}).querySelector(".via")).toBeNull();
  });
});
