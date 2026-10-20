import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { Composer } from "../src/composer";
import { feedback, messageElement } from "../src/messages";
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

  it("draw linked result pages as preview cards that open full-size", () => {
    const preview = { template: "<button onclick=\"ccb.open(ccb.data.url, ccb.data.title)\">open</button>", version: 0, working: false, updated: false, hasPrevious: false };
    const data = JSON.stringify({ path: "/p/.bot/artifacts/a.html", title: "A", url: "file:///p/.bot/artifacts/a.html", src: "ccb-preview://page/p/.bot/artifacts/a.html" });
    const row = messageElement(message({
      id: "m20", text: "Done: [A](file:///p/.bot/artifacts/a.html)",
      previews: [{ name: "網頁預覽卡片", data }],
    }), { "網頁預覽卡片": preview });
    document.body.append(row);
    // The link stays a chip; the card comes under it.
    expect(row.querySelector(".chip")).not.toBeNull();
    const frame = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    expect(frame.title).toBe("網頁預覽卡片");
    expect(frame.srcdoc).toContain("ccb-preview://page/p/.bot/artifacts/a.html");
    expect(frame.srcdoc).toContain("open(url, label)");
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "open", url: "file:///p/.bot/artifacts/a.html", label: "A" }, source: frame.contentWindow }));
    expect(sent).toEqual([{ type: "openURL", url: "file:///p/.bot/artifacts/a.html", label: "A" }]);
    // Without the template the link is all there is.
    const bare = messageElement(message({ id: "m21", text: "[A](file:///p/.bot/artifacts/a.html)", previews: [{ name: "網頁預覽卡片", data }] }), {});
    expect(bare.querySelector(".component-frame")).toBeNull();
  });

  it("name who said a line in the group chat", () => {
    const row = messageElement(message({ text: "Garden is green.", speaker: "garden" }), {});
    expect(row.querySelector(".speaker")?.textContent).toBe("garden");
    expect(row.querySelector(".speaker-column .bot-bubble")?.textContent).toContain("Garden is green.");
    expect(messageElement(message({ text: "x" }), {}).querySelector(".speaker")).toBeNull();
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

  it("send a component report with a screenshot of it unless you untick it", async () => {
    const row = messageElement(message({
      open: true, choices: [{ label: "A", detail: null, recommended: false }],
    }), { choices: { template: "<button>A</button>", version: 0, working: false, updated: false, hasPrevious: false } });
    document.body.append(row);
    row.querySelector<HTMLButtonElement>(".flag")!.click();
    const box = document.querySelector(".report")!;
    const send = box.querySelector<HTMLButtonElement>(".send")!;
    // The screenshot alone is no request.
    expect(send.disabled).toBe(true);
    expect(box.querySelector<HTMLInputElement>(".report-shot input")!.checked).toBe(true);
    const textarea = box.querySelector("textarea")!;
    textarea.value = "Put them in a row";
    textarea.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(false);
    send.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.querySelector(".report")).toBeNull();
    expect(sent).toEqual([{ type: "componentReport", name: "choices", text: "Put them in a row", images: [], rect: { x: 0, y: 0, width: 0, height: 0 } }]);
  });

  it("show the pictures handed over with work under the relay line", () => {
    const row = messageElement(message({ role: "relay", text: "Fix the card", attachments: [{ name: "shot.png", kind: "image", url: "file:///tmp/shot.png" }] }), {});
    expect(row.querySelector(".relay")?.textContent).toContain("Fix the card");
    expect(row.querySelector<HTMLImageElement>(".attachments img")?.getAttribute("src")).toBe("file:///tmp/shot.png");
  });

  it("fold a reply's steps and open a subagent from its card", () => {
    const step = (id: string, kind: "tool" | "text" | "subagent", title: string, extra: Partial<import("../src/types").StepView> = {}) =>
      ({ id, kind, tool: null, title, detail: null, output: null, failed: false, done: true, status: null, count: null, ...extra });
    const row = messageElement(message({ id: "r1", text: "Done.", steps: [
      step("s1", "tool", "Run swift test", { detail: "swift test", output: "ok" }),
      step("toolu_A", "subagent", "Check the form", { status: "running", count: 2, done: false }),
    ] }), {});
    document.body.append(row);
    expect(row.querySelector(".steps-toggle")?.textContent).toBe("Worked · 2 steps · 1 subagent (1 running)");
    // Folded: the step lines are hidden, the subagent card is not.
    const lists = row.querySelectorAll<HTMLElement>(".steps .step-list");
    expect(lists[0].hidden).toBe(true);
    expect(lists[1].hidden).toBe(false);
    lists[1].querySelector<HTMLButtonElement>(".subagent-card")!.click();
    expect(sent).toEqual([{ type: "openSubagent", id: "toolu_A" }]);
    row.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(lists[0].hidden).toBe(false);
    expect(lists[1].hidden).toBe(true);
    const head = lists[0].querySelector<HTMLButtonElement>(".step-head")!;
    head.click();
    expect(lists[0].querySelector<HTMLElement>(".step-body")!.hidden).toBe(false);
    expect(lists[0].querySelector("pre")?.textContent).toBe("swift test");
  });

  it("flag a bot's reply as not right in developer mode only", async () => {
    feedback.enabled = false;
    expect(messageElement(message({ text: "Hi" }), {}).querySelector(".feedback-button")).toBeNull();
    feedback.enabled = true;
    const row = messageElement(message({ id: "r9", text: "Hi" }), {});
    document.body.append(row);
    expect(messageElement(message({ role: "user", text: "Me" }), {}).querySelector(".feedback-button")).toBeNull();
    row.querySelector<HTMLButtonElement>(".feedback-button")!.click();
    const box = document.querySelector(".report")!;
    box.querySelector("textarea")!.value = "It answered half";
    box.querySelector<HTMLButtonElement>(".send")!.click();
    expect(sent).toEqual([]);
    await new Promise((done) => requestAnimationFrame(() => done(null)));
    expect(sent).toEqual([{ type: "feedback", messageID: "r9", text: "It answered half", images: [] }]);
    expect(document.querySelector(".report")).toBeNull();
    feedback.enabled = false;
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

  it("completes @names and puts the chosen one in on Return", () => {
    const composer = new Composer(document.body);
    composer.update(state({ mentions: ["Main bot", "Morning news", "garden"] }));
    composer.insert("Hi @mo");
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["@Morning news"]);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    composer.view.contentDOM.dispatchEvent(enter);
    expect(composer.text).toBe("Hi @Morning news ");
    expect(list.hidden).toBe(true);
    expect(sent).toEqual([]);
    // No names here (a bot's own chat): no list.
    composer.update(state());
    composer.insert("@m");
    expect(list.hidden).toBe(true);
  });

  it("completes @names right after Chinese, leaves Shift-Return alone, and sends a full name", () => {
    const composer = new Composer(document.body);
    composer.update(state({ mentions: ["garden", "garden", "News", "News digest"] }));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    composer.insert("請看@ga");
    expect([...list.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["@garden"]);
    // With a modifier the key is not the list's (Shift-Return makes a new line).
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    composer.view.contentDOM.dispatchEvent(shiftTab);
    expect(composer.text).toBe("請看@ga");
    composer.setText("");
    composer.insert("a@ga");
    expect(list.hidden).toBe(true);
    composer.setText("");
    composer.insert("@News");
    // "News" is typed in full: no list, so Return would send.
    expect(list.hidden).toBe(true);
    // The names going away closes the list.
    composer.setText("");
    composer.insert("@ga");
    expect(list.hidden).toBe(false);
    composer.update(state({ mentions: [] }));
    expect(list.hidden).toBe(true);
  });

  it("offers components after @ in any chat, after the group's bots, and puts the picked one in", () => {
    const composer = new Composer(document.body);
    composer.update(state({ componentMentions: ["choices", "網頁預覽卡片", "天氣卡片"] }));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    composer.insert("看這個@網");
    expect(list.hidden).toBe(false);
    const options = [...list.querySelectorAll("button")];
    expect(options.map((b) => b.querySelector(".mention-name")?.textContent)).toEqual(["@網頁預覽卡片"]);
    expect(options[0].querySelector(".mention-kind")?.textContent).toBe("組件");
    composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(composer.text).toBe("看這個@網頁預覽卡片 ");
    expect(sent).toEqual([]);
    // In a group chat the bots come first; a component named like a bot is offered once, as the bot.
    composer.setText("");
    composer.update(state({ mentions: ["garden", "choices"], componentMentions: ["choices", "網頁預覽卡片"] }));
    composer.insert("@");
    const all = [...list.querySelectorAll("button")];
    expect(all.map((b) => b.querySelector(".mention-name")?.textContent)).toEqual(["@garden", "@choices", "@網頁預覽卡片"]);
    expect(all.map((b) => b.querySelector(".mention-kind") !== null)).toEqual([false, false, true]);
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
