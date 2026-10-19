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
    botID: "b1", botName: "Main bot", messages: [], working: false, avatar: "", placeholder: "Make a wish…",
    replyingTo: null, pendingFiles: [], components: {}, ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
});

describe("messages", () => {
  it("draw a bot reply as markdown with a reply button", () => {
    const row = messageElement(message({ text: "**OK** $x$" }), {});
    expect(row.querySelector("strong")?.textContent).toBe("OK");
    // LaTeX is the ccb-latex plugin's job, not the core's.
    expect(row.querySelector(".katex")).toBeNull();
    row.querySelector<HTMLButtonElement>(".reply-button")!.click();
    expect(sent).toEqual([{ type: "reply", messageID: "m1" }]);
  });

  it("draw your message with its quote and files", () => {
    const row = messageElement(message({
      role: "user", text: "What is this?", replyTo: "m0", replyPreview: "Right panel 70% done",
      attachments: [{ name: "a.png", kind: "image", url: "file:///tmp/a.png" }, { name: "b.pdf", kind: "file", url: "file:///tmp/b.pdf" }],
    }), {});
    expect(row.querySelector(".quote")?.textContent).toContain("Right panel 70% done");
    expect(row.querySelector(".thumb")?.getAttribute("src")).toBe("file:///tmp/a.png");
    expect(row.querySelector(".file-chip")?.textContent).toContain("b.pdf");
  });

  it("draw open choices as buttons that answer, without a template", () => {
    const row = messageElement(message({
      text: "Which one?", open: true,
      choices: [{ label: "A", detail: "fast", recommended: true }, { label: "B", detail: null, recommended: false }],
    }), {});
    const buttons = row.querySelectorAll<HTMLButtonElement>(".choice");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain("Recommended · fast");
    buttons[1].click();
    expect(sent).toEqual([{ type: "choose", messageID: "m1", index: 1 }]);
  });

  it("fold answered choices to what was picked, and open them again disabled", () => {
    const row = messageElement(message({
      choices: [{ label: "A", detail: null, recommended: false }], chosen: null, answer: "Something else", open: false,
    }), {});
    expect(row.querySelector(".choice")).toBeNull();
    const folded = row.querySelector<HTMLButtonElement>(".folded-choice")!;
    expect(folded.textContent).toContain("Something else");
    folded.click();
    expect(row.querySelector(".folded-choice")).toBeNull();
    expect(row.querySelector<HTMLButtonElement>(".choice")!.disabled).toBe(true);
    // Folding it back, and a redraw of the opened one stays open.
    row.querySelector<HTMLButtonElement>(".fold")!.click();
    expect(row.querySelector(".folded-choice")?.textContent).toContain("Something else");
    expect(sent).toEqual([]);
  });

  it("fold a picked option to its label, and keep it open across a redraw once opened", () => {
    const answered = message({
      id: "m7", choices: [{ label: "Wait for the app", detail: null, recommended: true }, { label: "Do it now", detail: "today", recommended: false }],
      chosen: 0, open: false,
    });
    const row = messageElement(answered, {});
    expect(row.querySelector(".folded-choice .picked-label")?.textContent).toBe("Wait for the app");
    row.querySelector<HTMLButtonElement>(".folded-choice")!.click();
    const redrawn = messageElement(answered, {});
    expect(redrawn.querySelectorAll(".choice")).toHaveLength(2);
    expect(redrawn.querySelector(".fold")).not.toBeNull();
  });

  it("fold without a tick, fall back to a word, and keep focus on the toggle", () => {
    const row = messageElement(message({
      id: "m8", choices: [{ label: "Allow once", detail: null, recommended: true }, { label: "Don't allow", detail: null, recommended: false }], chosen: 1,
    }), {});
    document.body.append(row);
    const folded = row.querySelector<HTMLButtonElement>(".folded-choice")!;
    expect(folded.textContent).toBe("Don't allow");
    expect(folded.title).toBe("Don't allow");
    folded.focus();
    folded.click();
    expect(document.activeElement?.className).toBe("fold");
    (document.activeElement as HTMLButtonElement).click();
    expect(document.activeElement?.className).toBe("folded-choice");
    const odd = messageElement(message({ id: "m10", choices: [{ label: "A", detail: null, recommended: false }], chosen: 5 }), {});
    expect(odd.querySelector(".folded-choice")?.textContent).toBe("Answered");
  });

  it("keep data from closing the component's script", async () => {
    const { componentPage } = await import("../src/components");
    const page = componentPage("<p></p>", JSON.stringify({ name: "</script><script>parent.postMessage(1,'*')</script>" }));
    expect(page).not.toContain("</script><script>parent");
    expect(page).toContain("\\u003c/script>");
  });

  it("keep open choices unfolded", () => {
    const row = messageElement(message({ open: true, choices: [{ label: "A", detail: null, recommended: false }] }), {});
    expect(row.querySelector(".folded-choice")).toBeNull();
    expect(row.querySelector(".fold")).toBeNull();
  });

  it("start a redrawn component frame at the height it had", () => {
    const components = { choices: { template: "<p>hi</p>", version: 0, working: false, updated: false, hasPrevious: false } };
    const open = message({ id: "m9", open: true, choices: [{ label: "A", detail: null, recommended: false }] });
    const row = messageElement(open, components);
    document.body.append(row);
    const frame = row.querySelector("iframe")!;
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "size", height: 214 }, source: frame.contentWindow }));
    expect(frame.style.height).toBe("214px");
    const again = messageElement(open, components);
    expect(again.querySelector("iframe")!.style.height).toBe("214px");
  });

  it("put a template component in a sandboxed frame with its flag", () => {
    const row = messageElement(message({
      open: true, choices: [{ label: "A", detail: null, recommended: false }],
    }), { choices: { template: "<button onclick=\"ccb.answer(0)\">A</button>", version: 0, working: false, updated: true, hasPrevious: true } });
    const frame = row.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain('"options"');
    expect(row.querySelector(".flag")).not.toBeNull();
    expect(row.querySelector(".updated")?.textContent).toBe("Updated");
  });

  it("let a notice open its project", () => {
    const row = messageElement(message({ role: "notice", text: "garden: done", openable: true }), {});
    row.querySelector<HTMLButtonElement>(".open-source")!.click();
    expect(sent).toEqual([{ type: "openSource", messageID: "m1" }]);
  });
});

describe("composer", () => {
  it("sends on Return and clears", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    composer.setText("Hello");
    expect(composer.submit()).toBe(true);
    expect(sent).toEqual([{ type: "send", text: "Hello" }]);
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
      replyingTo: { id: "m1", who: "Reply to Main bot", preview: "Right panel 70% done" },
      pendingFiles: [{ id: "f1", name: "a.png", kind: "image", url: "file:///tmp/a.png" }],
    }));
    expect(document.querySelector(".reply-preview")?.textContent).toBe("Right panel 70% done");
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
