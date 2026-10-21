import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import type { MessageView } from "../src/types";

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
});

describe("artifact cards", () => {
  it("draw a claude.ai Artifact link as a card whose Open goes to the app", () => {
    const url = "https://claude.ai/code/artifact/0b5c-perf";
    const row = messageElement(message({
      text: `效能報告好了：[效能報告](${url})`,
      artifacts: [{ title: "效能報告", url, host: "claude.ai" }],
    }), {});
    const cards = row.querySelectorAll(".artifact-card");
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector(".artifact-title")?.textContent).toBe("效能報告");
    expect(cards[0].querySelector(".artifact-host")?.textContent).toBe("claude.ai · Artifact");
    // No live embed: it would need the user's sign-in.
    expect(cards[0].querySelector("iframe")).toBeNull();
    cards[0].querySelector<HTMLButtonElement>(".artifact-open")!.click();
    expect(sent).toEqual([{ type: "openURL", url, label: "效能報告" }]);
  });

  it("draw none for a reply without Artifacts", () => {
    const row = messageElement(message({ text: "[docs](https://example.com)" }), {});
    expect(row.querySelector(".artifact-card")).toBeNull();
  });

  it("draw a title as text, never as markup", () => {
    const row = messageElement(message({
      text: "x",
      artifacts: [{ title: "<img src=x onerror=alert(1)>", url: "https://claude.ai/artifact/a", host: "claude.ai" }],
    }), {});
    expect(row.querySelector(".artifact-card img")).toBeNull();
    expect(row.querySelector(".artifact-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
