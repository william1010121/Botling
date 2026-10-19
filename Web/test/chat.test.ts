import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { Composer } from "../src/composer";
import { messageElement } from "../src/messages";
import type { ChatState, MessageView } from "../src/types";

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "主 bot", messages: [], working: false, avatar: "", placeholder: "許個願…",
    replyingTo: null, pendingFiles: [], components: {}, ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
});

describe("messages", () => {
  it("draw a bot reply as markdown with a reply button", () => {
    const row = messageElement(message({ text: "**好** $x$" }), {});
    expect(row.querySelector("strong")?.textContent).toBe("好");
    // LaTeX is the ccb-latex plugin's job, not the core's.
    expect(row.querySelector(".katex")).toBeNull();
    row.querySelector<HTMLButtonElement>(".reply-button")!.click();
    expect(sent).toEqual([{ type: "reply", messageID: "m1" }]);
  });

  it("draw your message with its quote and files", () => {
    const row = messageElement(message({
      role: "user", text: "這是什麼？", replyTo: "m0", replyPreview: "右側面板 7 成",
      attachments: [{ name: "a.png", kind: "image", url: "file:///tmp/a.png" }, { name: "b.pdf", kind: "file", url: "file:///tmp/b.pdf" }],
    }), {});
    expect(row.querySelector(".quote")?.textContent).toContain("右側面板 7 成");
    expect(row.querySelector(".thumb")?.getAttribute("src")).toBe("file:///tmp/a.png");
    expect(row.querySelector(".file-chip")?.textContent).toContain("b.pdf");
  });

  it("draw open choices as buttons that answer, without a template", () => {
    const row = messageElement(message({
      text: "要哪個？", open: true,
      choices: [{ label: "甲", detail: "快", recommended: true }, { label: "乙", detail: null, recommended: false }],
    }), {});
    const buttons = row.querySelectorAll<HTMLButtonElement>(".choice");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain("建議 · 快");
    buttons[1].click();
    expect(sent).toEqual([{ type: "choose", messageID: "m1", index: 1 }]);
  });

  it("draw answered choices disabled", () => {
    const row = messageElement(message({
      choices: [{ label: "甲", detail: null, recommended: false }], chosen: null, answer: "其他想法", open: false,
    }), {});
    expect(row.querySelector<HTMLButtonElement>(".choice")!.disabled).toBe(true);
  });

  it("put a template component in a sandboxed frame with its flag", () => {
    const row = messageElement(message({
      open: true, choices: [{ label: "甲", detail: null, recommended: false }],
    }), { choices: { template: "<button onclick=\"ccb.answer(0)\">甲</button>", version: 0, working: false, updated: true, hasPrevious: true } });
    const frame = row.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain('"options"');
    expect(row.querySelector(".flag")).not.toBeNull();
    expect(row.querySelector(".updated")?.textContent).toBe("已更新");
  });

  it("let a notice open its project", () => {
    const row = messageElement(message({ role: "notice", text: "garden：好了", openable: true }), {});
    row.querySelector<HTMLButtonElement>(".open-source")!.click();
    expect(sent).toEqual([{ type: "openSource", messageID: "m1" }]);
  });
});

describe("composer", () => {
  it("sends on Return and clears", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    composer.setText("你好");
    expect(composer.submit()).toBe(true);
    expect(sent).toEqual([{ type: "send", text: "你好" }]);
    expect(composer.text).toBe("");
  });

  it("does not send empty text, but sends files alone", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    composer.submit();
    expect(sent).toEqual([]);
    composer.update(state({ pendingFiles: [{ id: "f1", name: "a.png", kind: "image", url: "file:///tmp/a.png" }] }));
    composer.submit();
    expect(sent).toEqual([{ type: "send", text: "" }]);
  });

  it("shows the reply bar and pending files", () => {
    const composer = new Composer(document.body);
    composer.update(state({
      replyingTo: { id: "m1", who: "回覆 主 bot", preview: "右側面板 7 成" },
      pendingFiles: [{ id: "f1", name: "a.png", kind: "image", url: "file:///tmp/a.png" }],
    }));
    expect(document.querySelector(".reply-preview")?.textContent).toBe("右側面板 7 成");
    document.querySelector<HTMLButtonElement>(".pending .remove")!.click();
    document.querySelector<HTMLButtonElement>(".reply-bar .close")!.click();
    expect(sent).toEqual([{ type: "removeFile", id: "f1" }, { type: "cancelReply" }]);
  });

  it("leaves Return to the input method while it is composing", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    composer.setText("ㄋㄧˇ");
    const content = composer.view.contentDOM;
    content.dispatchEvent(new CompositionEvent("compositionstart"));
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true }));
    expect(sent).toEqual([]);
  });
});
