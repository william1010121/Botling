/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { Composer } from "../src/composer";
import { feedback, messageElement, typingElement } from "../src/messages";
import type { ChatState, MessageView, PinSize } from "../src/types";

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

// jsdom has no ResizeObserver; the report box and preview cards use one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

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

  it("draw a call auto mode blocked for a subagent with that subagent, and open it", () => {
    const row = messageElement(message({
      text: "Subagent “Fix group B”: auto mode blocked `Bash`:", open: true,
      fromSubagent: { id: "toolu_A", title: "Fix group B" },
    }), {});
    const from = row.querySelector<HTMLButtonElement>(".from-subagent")!;
    expect(from.textContent).toContain("Subagent");
    expect(from.textContent).toContain("Fix group B");
    from.click();
    expect(sent).toEqual([{ type: "openSubagent", id: "toolu_A" }]);
    // The bot's own messages say nothing of the kind.
    expect(messageElement(message({ text: "Hi" }), {}).querySelector(".from-subagent")).toBeNull();
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

  it("keep an open question's options pressable when the app leaves out its empty answer", () => {
    // Swift's JSONEncoder drops nil fields: an open question arrives with no chosen or answer.
    const view = message({ choices: [{ label: "Allow once", detail: null, recommended: true }], open: true }) as Partial<MessageView>;
    delete view.chosen;
    delete view.answer;
    const row = messageElement(view as MessageView, {});
    expect(row.querySelector(".folded-choice")).toBeNull();
    row.querySelector<HTMLButtonElement>(".choice")!.click();
    expect(sent).toEqual([{ type: "choose", messageID: "m1", index: 0 }]);
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

  it("send pictures a component attaches with its words, and a picture alone", () => {
    const choices = { template: "<p>pick</p>", version: 0, working: false, updated: false, hasPrevious: false };
    const row = messageElement(message({ id: "q1", open: true, choices: [{ label: "A", detail: null, recommended: false }] }), { choices });
    document.body.append(row);
    const source = row.querySelector<HTMLIFrameElement>(".component-frame")!.contentWindow;
    const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source }));
    say({ ccb: "answer", text: "Like this", images: [{ name: "a.png", base64: "AA==" }, { name: "bad" }, "nope"] });
    say({ ccb: "answer", text: "", images: [{ name: "b.jpg", base64: "BB==" }] });
    say({ ccb: "answer", text: "  ", images: [] });
    say({ ccb: "answer", index: 0 });
    expect(sent).toEqual([
      { type: "answer", messageID: "q1", text: "Like this", images: [{ name: "a.png", base64: "AA==" }] },
      { type: "answer", messageID: "q1", text: "", images: [{ name: "b.jpg", base64: "BB==" }] },
      { type: "choose", messageID: "q1", index: 0 },
    ]);
  });

  it("hand a shown component the pictures its data names, and its pictures back", () => {
    const gallery = { template: "<img id=\"i\">", version: 0, working: false, updated: false, hasPrevious: false };
    const row = messageElement(message({
      id: "s1", text: "Here:",
      displays: [{ name: "gallery", data: JSON.stringify({ image: "/p/chart.png" }), images: { "/p/chart.png": "ccb-preview://page/p/chart.png?v=1" } }],
    }), { gallery });
    document.body.append(row);
    const frame = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    expect(frame.srcdoc).toContain("ccb-preview://page/p/chart.png?v=1");
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "answer", text: "Brighter", images: [{ name: "x.png", base64: "AA==" }] }, source: frame.contentWindow }));
    expect(sent).toEqual([{ type: "answer", messageID: "s1", text: "Brighter", images: [{ name: "x.png", base64: "AA==" }] }]);
  });

  it("give templates answer({text, images}), image(path) and the old ways to answer", async () => {
    const { componentPage } = await import("../src/components");
    const page = componentPage("<p>hi</p>", JSON.stringify({ image: "/p/a.png" }), { "/p/a.png": "ccb-preview://page/p/a.png" });
    // The frame's own script, run against a stand-in window and parent.
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const posted: unknown[] = [];
    const frame = { addEventListener() {} } as unknown as { ccb: Record<string, (...args: unknown[]) => unknown>; deck: unknown };
    new Function("window", "parent", script)(frame, { postMessage: (data: unknown) => posted.push(data) });
    expect(frame.deck).toBe(frame.ccb);
    expect(frame.ccb.image("/p/a.png")).toBe("ccb-preview://page/p/a.png");
    expect(frame.ccb.image("/p/not-named.png")).toBe("");
    expect(frame.ccb.image("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
    await frame.ccb.answer({ text: "Like this", images: ["data:image/jpeg;base64,QUJD", { name: "mine.png", base64: "AA==" }, null] });
    await frame.ccb.answer(2);
    await frame.ccb.answer("words");
    expect(posted).toEqual([
      { ccb: "answer", text: "Like this", images: [{ name: "Picture 1.jpg", base64: "QUJD" }, { name: "mine.png", base64: "AA==" }] },
      { ccb: "answer", index: 2 },
      { ccb: "answer", text: "words" },
    ]);
    expect(typeof frame.ccb.pickImage).toBe("function");
    expect(typeof frame.ccb.readImage).toBe("function");
  });

  it("pass a component's ccb.reviewWithCodex on to Swift as text or null", async () => {
    const { componentPage, codexReviewAction } = await import("../src/components");
    const page = componentPage("<p>hi</p>", "{}");
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const posted: unknown[] = [];
    const frame = { addEventListener() {} } as unknown as { ccb: Record<string, (...args: unknown[]) => unknown> };
    new Function("window", "parent", script)(frame, { postMessage: (data: unknown) => posted.push(data) });
    await frame.ccb.reviewWithCodex({ commit: "ee988b9", spec: "/p/plan.md" });
    await frame.ccb.reviewWithCodex();
    expect(posted).toEqual([
      { ccb: "reviewWithCodex", scope: null, commit: "ee988b9", spec: "/p/plan.md" },
      { ccb: "reviewWithCodex", scope: null, commit: null, spec: null },
    ]);
    expect(codexReviewAction({ scope: "lastCommit", commit: 7, spec: "  " })).toEqual({ type: "codexReview", scope: "lastCommit", commit: null, spec: null });
    // From a component's frame, it reaches Swift.
    const row = messageElement(message({ id: "m30", displays: [{ name: "log", data: "{}", at: null }] }), { log: { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false } });
    document.body.append(row);
    const shown = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "reviewWithCodex", scope: "uncommitted", commit: null, spec: null }, source: shown.contentWindow }));
    expect(sent).toEqual([{ type: "codexReview", scope: "uncommitted", commit: null, spec: null }]);
  });

  it("tell a component its size: ccb.size, <html data-size> and ccb.onSize", async () => {
    const { componentPage } = await import("../src/components");
    const page = componentPage("<p>hi</p>", "{}", {}, "2x1");
    expect(page).toContain('<html data-size="2x1" data-surface="chat">');
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const listeners: Record<string, (event: { source?: unknown; data?: unknown }) => void> = {};
    const hear = (event: { source: unknown; data: unknown }) => listeners.message(event);
    const parent = { postMessage() {} };
    // The frame's own width and height, as a stand-in window has them.
    const frame = { innerWidth: 330.4, innerHeight: 158, addEventListener: (type: string, listener: (event: { source?: unknown; data?: unknown }) => void) => { listeners[type] = listener; } } as unknown as { innerWidth: number; innerHeight: number; ccb: { size: unknown; onSize: (fn: (size: unknown) => void) => () => void } };
    new Function("window", "parent", script)(frame, parent);
    expect(frame.ccb.size).toEqual({ w: 2, h: 1, name: "wide", px: { width: 330, height: 158 } });
    const heard: unknown[] = [];
    const stop = frame.ccb.onSize((size) => heard.push(size));
    hear({ source: {}, data: { ccbSize: { w: 1, h: 1, name: "small" } } });
    hear({ source: parent, data: { ccbSize: { w: 2, h: 1, name: "wide" } } });
    hear({ source: parent, data: { ccbSize: { w: 1, h: 2, name: "tall" } } });
    expect(heard).toEqual([{ w: 1, h: 2, name: "tall", px: { width: 330, height: 158 } }]);
    expect(frame.ccb.size).toEqual({ w: 1, h: 2, name: "tall", px: { width: 330, height: 158 } });
    expect(document.documentElement.dataset.size).toBe("1x2");
    // Its pixels change (a drag between cells, a narrower window): heard too, cells as they were.
    frame.innerWidth = 160;
    frame.innerHeight = 332;
    listeners.resize({});
    listeners.resize({});
    expect(heard).toHaveLength(2);
    expect(heard[1]).toEqual({ w: 1, h: 2, name: "tall", px: { width: 160, height: 332 } });
    stop();
    hear({ source: parent, data: { ccbSize: { w: 2, h: 2, name: "large" } } });
    expect(heard).toHaveLength(2);
    delete document.documentElement.dataset.size;
  });

  it("tell a component it is a Board tile: ccb.surface and <html data-surface>", async () => {
    const { componentPage } = await import("../src/components");
    const page = componentPage("<p>hi</p>", "{}", {}, "1x1", "board");
    expect(page).toContain('<html data-size="1x1" data-surface="board" data-fill>');
    // On the Board the page is the tile's height, so a layout can fill it.
    expect(page).toContain('html[data-surface="board"] #ccb-root{height:100%}');
    // Its root is a CSS container the tile's size, so container queries just work; elsewhere
    // (as tall as its content) one of its width.
    expect(page).toContain("#ccb-root{container-type:inline-size;container-name:ccb}");
    expect(page).toContain("html[data-fill] #ccb-root{container-type:size}");
    expect(componentPage("<p>hi</p>", "{}")).not.toContain("<html data-size=\"2x2\" data-surface=\"chat\" data-fill");
    // A pin opened above the input box fills its panel once the user gave it a height.
    expect(componentPage("<p>hi</p>", "{}", {}, "2x2", "pinned", true)).toContain('<html data-size="2x2" data-surface="pinned" data-fill>');
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const frame = { addEventListener() {} } as unknown as { ccb: { surface: string } };
    new Function("window", "parent", script)(frame, { postMessage() {} });
    expect(frame.ccb.surface).toBe("board");
    expect(componentPage("<p>hi</p>", "{}")).toContain('surface: "chat"');
  });

  it("tell a component it is pinned above the input box: ccb.surface pinned, as tall as its content", async () => {
    const { componentPage } = await import("../src/components");
    const page = componentPage("<p>hi</p>", "{}", {}, "2x2", "pinned");
    expect(page).toContain('<html data-size="2x2" data-surface="pinned">');
    // Not the Board's fixed height: the panel follows the component's own height.
    expect(page).not.toContain('html[data-surface="pinned"] #ccb-root{height:100%}');
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const frame = { addEventListener() {} } as unknown as { ccb: { surface: string } };
    new Function("window", "parent", script)(frame, { postMessage() {} });
    expect(frame.ccb.surface).toBe("pinned");
  });

  it("let a component load details on demand with ccb.runDetail", async () => {
    const { componentPage, detailReply } = await import("../src/components");
    // The frame's side: a promise per call, settled by the page's answer (only from its parent).
    const page = componentPage("<p>hi</p>", "{}");
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const posted: unknown[] = [];
    let hear: (event: { source: unknown; data: unknown }) => void = () => {};
    const parent = { postMessage: (data: unknown) => posted.push(data) };
    const frame = { addEventListener: (_: string, listener: typeof hear) => { hear = listener; } } as unknown as { ccb: Record<string, (...args: unknown[]) => Promise<unknown>> };
    new Function("window", "parent", script)(frame, parent);
    const first = frame.ccb.runDetail({ hash: "2aed630", n: 3 });
    const second = frame.ccb.runDetail({ hash: "-p" });
    expect(posted).toEqual([
      { ccb: "runDetail", id: 1, values: { hash: "2aed630", n: 3 } },
      { ccb: "runDetail", id: 2, values: { hash: "-p" } },
    ]);
    hear({ source: {}, data: { ccbDetail: 1, ok: true, value: "forged" } });
    hear({ source: parent, data: { ccbDetail: 2, ok: false, error: "The value for {hash} starts with \"-\"." } });
    hear({ source: parent, data: { ccbDetail: 1, ok: true, value: { files: 2 } } });
    await expect(first).resolves.toEqual({ files: 2 });
    await expect(second).rejects.toThrow("starts with");

    // The page's side: a card whose component has a Detail command passes calls on with its folder.
    const info = { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false };
    const row = messageElement(message({
      id: "m31",
      displays: [
        { name: "commits", data: "[]", at: null, command: "git log", folder: "/p", detail: "git show {hash}", status: "done" },
        { name: "plain", data: "{}", at: null },
      ],
    }), { commits: info, plain: info });
    document.body.append(row);
    const [withDetail, without] = [...row.querySelectorAll<HTMLIFrameElement>(".component-frame")];
    const replies: unknown[] = [];
    withDetail.contentWindow!.postMessage = ((data: unknown) => replies.push(data)) as Window["postMessage"];
    without.contentWindow!.postMessage = ((data: unknown) => replies.push(data)) as Window["postMessage"];
    const ask = (frame: HTMLIFrameElement, data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
    ask(withDetail, { ccb: "runDetail", id: 5, values: { hash: "2aed630" } });
    expect(sent).toEqual([{ type: "componentDetail", requestID: expect.any(Number), name: "commits", folder: "/p", values: { hash: "2aed630" } }]);
    const requestID = (sent[0] as { requestID: number }).requestID;
    detailReply(requestID, true, '{"stat":"1 file changed"}');
    detailReply(requestID, true, '"again"');
    ask(withDetail, { ccb: "runDetail", id: 6, values: { hash: "x" } });
    detailReply((sent[1] as { requestID: number }).requestID, true, "not json");
    ask(withDetail, { ccb: "runDetail", id: 7, values: { hash: { nested: 1 } } });
    ask(without, { ccb: "runDetail", id: 8, values: { hash: "2aed630" } });
    expect(replies).toEqual([
      { ccbDetail: 5, ok: true, value: { stat: "1 file changed" } },
      { ccbDetail: 6, ok: true, value: "not json" },
      { ccbDetail: 7, ok: false, error: "The value for {hash} must be text or a number." },
      { ccbDetail: 8, ok: false, error: expect.stringContaining("no Detail command") },
    ]);
    expect(sent).toHaveLength(2);
    detailReply(99, false, "nobody asked");
    expect(replies).toHaveLength(4);
  });

  it("save a ccb.runDetail's output into its card when asked ({save: true})", async () => {
    const { componentPage } = await import("../src/components");
    const page = componentPage("<p>hi</p>", "{}");
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    const posted: unknown[] = [];
    const frame = { addEventListener() {} } as unknown as { ccb: Record<string, (...args: unknown[]) => Promise<unknown>> };
    new Function("window", "parent", script)(frame, { postMessage: (data: unknown) => posted.push(data) });
    void frame.ccb.runDetail({ scan: "now" }, { save: true });
    expect(posted).toEqual([{ ccb: "runDetail", id: 1, values: { scan: "now" }, save: true }]);

    // The page passes the card and its command on, so Swift saves the output into it even
    // when this page is gone by the time the scan ends.
    const info = { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false };
    const row = messageElement(message({
      id: "m33",
      displays: [{ name: "disk", data: "{}", at: null, command: "scan", folder: "/p", detail: "scan --force {scan}", card: "m33/0", status: "done" }],
    }), { disk: info });
    document.body.append(row);
    const card = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    card.contentWindow!.postMessage = (() => {}) as Window["postMessage"];
    const ask = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: card.contentWindow }));
    ask({ ccb: "runDetail", id: 1, values: { scan: "now" }, save: true });
    ask({ ccb: "runDetail", id: 2, values: { scan: "now" } });
    expect(sent).toEqual([
      { type: "componentDetail", requestID: expect.any(Number), name: "disk", folder: "/p", values: { scan: "now" }, card: "m33/0", command: "scan" },
      { type: "componentDetail", requestID: expect.any(Number), name: "disk", folder: "/p", values: { scan: "now" } },
    ]);
  });

  it("ask to allow a component's Detail command with its command", () => {
    const info = { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false };
    const row = messageElement(message({
      id: "m32",
      displays: [{ name: "commits", data: "null", at: null, command: "git log", folder: "/p", detail: "git show {hash}", status: "approve" }],
    }), { commits: info });
    document.body.append(row);
    expect([...row.querySelectorAll(".command-full")].map((pre) => pre.textContent)).toEqual(["git log", "git show {hash}"]);
    row.querySelector<HTMLButtonElement>(".command-allow")!.click();
    expect(sent).toEqual([{ type: "componentCommand", messageID: "m32", index: 0, command: "git log", folder: "/p", detail: "git show {hash}", approve: true }]);
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
    expect(frame.getAttribute("aria-label")).toBe("網頁預覽卡片");
    expect(frame.srcdoc).toContain("ccb-preview://page/p/.bot/artifacts/a.html");
    expect(frame.srcdoc).toContain("open(url, label)");
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "open", url: "file:///p/.bot/artifacts/a.html", label: "A" }, source: frame.contentWindow }));
    expect(sent).toEqual([{ type: "openURL", url: "file:///p/.bot/artifacts/a.html", label: "A" }]);
    // Without the template the link is all there is.
    const bare = messageElement(message({ id: "m21", text: "[A](file:///p/.bot/artifacts/a.html)", previews: [{ name: "網頁預覽卡片", data }] }), {});
    expect(bare.querySelector(".component-frame")).toBeNull();
  });

  it("ask before running a component's command, then run, refresh and show failures", () => {
    const components = { table: { template: "<pre id=t></pre>", version: 0, working: false, updated: false, hasPrevious: false } };
    const display = { name: "table", data: "null", at: null, command: "git diff --stat", folder: "/p/garden" };
    // Not allowed yet: only the ask, with the command and folder, no component.
    const asking = messageElement(message({ id: "c1", displays: [{ ...display, status: "approve" }] }), components);
    expect(asking.querySelector(".component-frame")).toBeNull();
    expect(asking.querySelector(".command-full")?.textContent).toBe("git diff --stat");
    expect(asking.querySelector(".command-folder")?.textContent).toBe("/p/garden");
    expect(asking.querySelector(".command-refresh")).toBeNull();
    asking.querySelector<HTMLButtonElement>(".command-allow")!.click();
    // With the command and folder it showed, so only what you saw is allowed.
    expect(sent).toEqual([{ type: "componentCommand", messageID: "c1", index: 0, command: "git diff --stat", folder: "/p/garden", approve: true }]);
    sent.length = 0;
    // Allowed but not run yet: asks for a run once, however often it is drawn.
    const idle = message({ id: "c2", displays: [{ ...display, status: "idle" }] });
    messageElement(idle, components);
    messageElement(idle, components);
    expect(sent).toEqual([{ type: "componentCommand", messageID: "c2", index: 0, command: "git diff --stat", folder: "/p/garden" }]);
    sent.length = 0;
    // Its command changed (say, about.md was edited): that one is asked for too.
    messageElement(message({ id: "c2", displays: [{ ...display, command: "git log -1", status: "idle" }] }), components);
    expect(sent).toEqual([{ type: "componentCommand", messageID: "c2", index: 0, command: "git log -1", folder: "/p/garden" }]);
    sent.length = 0;
    // Done: the component with the output, and a refresh button that runs it again.
    const done = messageElement(message({ id: "c3", displays: [{ ...display, data: JSON.stringify(" 2 files changed"), status: "done", ranAt: "10:42" }] }), components);
    expect(done.querySelector<HTMLIFrameElement>(".component-frame")!.srcdoc).toContain("2 files changed");
    expect(done.querySelector(".command-when")?.textContent).toBe("Ran 10:42");
    done.querySelector<HTMLButtonElement>(".command-refresh")!.click();
    expect(sent).toEqual([{ type: "componentCommand", messageID: "c3", index: 0, command: "git diff --stat", folder: "/p/garden", force: true }]);
    // Running again keeps the last output, with the button busy.
    const again = messageElement(message({ id: "c3", displays: [{ ...display, data: "[1]", status: "running" }] }), components);
    expect(again.querySelector(".component-frame")).not.toBeNull();
    expect(again.querySelector<HTMLButtonElement>(".command-refresh")!.disabled).toBe(true);
    // Failed: why, instead of the component; it can be tried again.
    const failed = messageElement(message({ id: "c4", displays: [{ ...display, status: "failed", error: "The command failed (exit code 128).\nnot a git repository" }] }), components);
    expect(failed.querySelector(".component-frame")).toBeNull();
    expect(failed.querySelector("[role=alert]")?.textContent).toContain("not a git repository");
    expect(failed.querySelector<HTMLButtonElement>(".command-refresh")!.disabled).toBe(false);
  });

  it("draw nothing for a bot's component shown with no data and no command (the bot is told instead)", () => {
    const components = { "git-diff": { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false } };
    const row = messageElement(message({
      id: "e1", text: "Fixed.\n\n\n\nPush it?",
      displays: [{ name: "git-diff", data: "null", at: 8, status: "empty" }],
    }), components);
    expect(row.querySelector(".command-card")).toBeNull();
    expect(row.querySelector("[role=alert]")).toBeNull();
    expect(row.querySelector(".component-frame")).toBeNull();
    expect(row.textContent).toContain("Push it?");
  });

  it("draw a component without a command as before", () => {
    const components = { table: { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false } };
    const row = messageElement(message({ displays: [{ name: "table", data: "[1]", at: null }] }), components);
    expect(row.querySelector(".command-card")).toBeNull();
    expect(row.querySelector(".component-frame")).not.toBeNull();
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

  it("draw a component in a reply wide and frameless: the whole column, its widest size, no card in a card", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    document.head.append(style);
    try {
      const info = { template: "<p></p>", version: 0, working: false, updated: false, hasPrevious: false };
      const components = { log: { ...info, sizes: ["1x1", "2x2", "4x2"] as PinSize[] }, table: info, 網頁預覽卡片: info };
      const row = messageElement(message({
        id: "w1", text: "Here they are: [A](file:///p/a.html)",
        displays: [
          { name: "log", data: "{}", at: null },
          { name: "table", data: "null", at: null, command: "git diff --stat", folder: "/p", status: "approve" },
        ],
        previews: [{ name: "網頁預覽卡片", data: "{}" }],
      }), components);
      document.body.append(row);
      const bubble = row.querySelector<HTMLElement>(".bot-bubble")!;
      // The reply spans the message column instead of shrinking to a narrow card.
      expect(bubble.classList.contains("wide")).toBe(true);
      expect(getComputedStyle(bubble).maxWidth).toBe("none");
      // Each component sits inside it, inset as its text is on both sides (never past its edge
      // or its rounded corners), and as wide as the text: the bubble is its frame, so a command's
      // card draws no border of its own, and its header lines up with the text too.
      const parts = [...bubble.querySelectorAll<HTMLElement>(":scope > .wide-part")];
      expect(parts).toHaveLength(3);
      const padding = getComputedStyle(bubble);
      expect(padding.paddingLeft).toBe("16px");
      expect(padding.paddingRight).toBe(padding.paddingLeft);
      for (const part of parts) {
        const style = getComputedStyle(part);
        expect(style.marginLeft).toBe("0px");
        expect(style.marginRight).toBe("0px");
      }
      const card = bubble.querySelector<HTMLElement>(".command-card")!;
      expect(getComputedStyle(card).borderTopStyle).toBe("none");
      for (const inner of card.querySelectorAll<HTMLElement>(":scope > :not(.component)")) {
        expect(getComputedStyle(inner).paddingLeft).toBe("0px");
        expect(getComputedStyle(inner).paddingRight).toBe("0px");
      }
      // Its frame has its own rounded corners, so a component that paints to its edge is clipped clean.
      for (const frame of bubble.querySelectorAll<HTMLElement>(".wide-part .component-frame")) {
        expect(getComputedStyle(frame).borderRadius).toBe("12px");
      }
      // The reply reaches the column's right edge, as the input box does: its hover actions float
      // over its top-right corner rather than taking a column beside it.
      expect(row.classList.contains("wide")).toBe(true);
      const actions = row.querySelector<HTMLElement>(":scope > .message-actions, :scope > .reply-button")!;
      expect(getComputedStyle(actions).position).toBe("absolute");
      expect(getComputedStyle(row).position).toBe("relative");
      // Told it is in the chat, at the widest size it has (2×2 when it names none).
      const frames = bubble.querySelectorAll<HTMLIFrameElement>(".component-frame");
      expect(frames[0].srcdoc).toContain('<html data-size="4x2" data-surface="chat">');
      expect(frames[1].srcdoc).toContain('<html data-size="2x2" data-surface="chat">');
      // Its report flag floats over it on hover rather than taking a column beside it.
      const shown = frames[0].closest<HTMLElement>(".component")!;
      expect(shown.dataset.surface).toBe("chat");
      expect(getComputedStyle(shown.querySelector<HTMLElement>(".component-side")!).position).toBe("absolute");

      // A reply of words alone keeps its own width.
      const words = messageElement(message({ id: "w2", text: "Just words." }), components);
      expect(words.querySelector(".bot-bubble")!.classList.contains("wide")).toBe(false);
      expect(words.classList.contains("wide")).toBe(false);
      // A question's options are not a wide component.
      const asked = messageElement(message({ id: "w3", open: true, choices: [{ label: "A", detail: null, recommended: false }] }),
        { choices: info });
      expect(asked.querySelector(".bot-bubble")!.classList.contains("wide")).toBe(false);
      expect(asked.querySelector(".wide-part")).toBeNull();
    } finally {
      style.remove();
    }
  });

  it("keep the Updated label on one line without squeezing the component", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    document.head.append(style);
    try {
      const row = messageElement(message({
        open: true, choices: [{ label: "A", detail: null, recommended: false }],
      }), { choices: { template: "<button>A</button>", version: 0, working: false, updated: true, hasPrevious: false } });
      document.body.append(row);
      const label = row.querySelector<HTMLElement>(".updated")!;
      const side = label.closest<HTMLElement>(".component-side")!;
      expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(side).flexShrink).toBe("0");
      // A fixed narrow width is what broke the word as "Updat / ed".
      expect(getComputedStyle(side).width).not.toBe("36px");
    } finally {
      style.remove();
    }
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

  it("show a feedback relay short, with the full report folded behind a toggle", () => {
    const text = "Feedback: the user flagged a reply of Maintainer as not right.\nWhat is wrong, in their words: Empty card\n\nThe chat up to that reply, oldest first:\n[2026-10-20 13:16] User: Show me";
    const view = message({
      id: "f1", role: "relay", text,
      feedback: { about: "Maintainer", words: "Empty card" },
      attachments: [{ name: "chat-shot.png", kind: "image", url: "file:///tmp/chat-shot.png" }],
    });
    const row = messageElement(view, {});
    expect(row.querySelector(".feedback-title")?.textContent).toContain("Maintainer");
    expect(row.querySelector(".feedback-words")?.textContent).toBe("Empty card");
    expect(row.querySelector<HTMLImageElement>(".attachments img")?.getAttribute("src")).toBe("file:///tmp/chat-shot.png");
    const full = row.querySelector<HTMLElement>(".feedback-full")!;
    expect(full.hidden).toBe(true);
    const toggle = row.querySelector<HTMLButtonElement>(".feedback-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(full.hidden).toBe(false);
    expect(full.textContent).toBe(text);
    // Still open after the chat is drawn again.
    expect(messageElement(view, {}).querySelector<HTMLElement>(".feedback-full")!.hidden).toBe(false);
    toggle.click();
    expect(full.hidden).toBe(true);
    expect(messageElement(message({ ...view, id: "f2", feedback: { about: "Maintainer", words: "" } }), {}).querySelector(".feedback-words.empty")).not.toBeNull();
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

  it("fold an earlier reply's finished subagents away, keeping running ones in sight", () => {
    const step = (id: string, title: string, status: string) =>
      ({ id, kind: "subagent" as const, tool: null, title, detail: null, output: null, failed: false, done: status !== "running", status, count: 0 });
    const steps = [step("a1", "Stopped one", "stopped"), step("a2", "Done one", "completed"), step("a3", "Still going", "running")];
    const cards = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".steps > .step-list:not([hidden]) .subagent-title")].map((card) => card.textContent);
    // The latest reply keeps every card in sight while folded.
    expect(cards(messageElement(message({ id: "e1", text: "Sent three.", steps }), {}))).toEqual(["Stopped one", "Done one", "Still going"]);
    // One before your latest line: only the running one; unfolded, all three are still listed.
    const earlier = messageElement(message({ id: "e2", text: "Sent three.", steps, earlier: true }), {});
    expect(cards(earlier)).toEqual(["Still going"]);
    earlier.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(earlier.querySelectorAll(".steps > .step-list:not([hidden]) .subagent-card").length).toBe(3);
    // All finished: no cards line at all.
    const settled = messageElement(message({ id: "e3", text: "Sent two.", steps: steps.slice(0, 2), earlier: true }), {});
    expect(cards(settled)).toEqual([]);
  });

  it("show the bot's words between tool calls in sight, each run of calls folded between them", () => {
    const step = (id: string, kind: "tool" | "text" | "subagent", title: string, extra: Partial<import("../src/types").StepView> = {}) =>
      ({ id, kind, tool: null, title, detail: null, output: null, failed: false, done: true, status: null, count: null, ...extra });
    const row = messageElement(message({ id: "r-text", text: "All green.", steps: [
      step("t0", "text", "First I'll look at the **tests**."),
      step("a1", "tool", "Read Package.swift"),
      step("a2", "tool", "Run swift test"),
      step("t1", "text", "Two failed; fixing them."),
      step("b1", "tool", "Edit Trace.swift"),
    ] }), {});
    document.body.append(row);
    const outer = row.querySelector<HTMLElement>(".steps")!;
    expect(outer.classList.contains("with-text")).toBe(true);
    // Folded by default to one line: only the final reply is in sight.
    const fold = outer.querySelector<HTMLButtonElement>(":scope > .steps-toggle")!;
    expect(fold.textContent).toBe("Worked · 2 notes · 3 steps");
    const steps = outer.querySelector<HTMLElement>(":scope > .steps-body")!;
    expect(steps.hidden).toBe(true);
    expect(row.querySelector(".bubble")?.textContent).toContain("All green.");
    fold.click();
    expect(steps.hidden).toBe(false);
    expect(outer.classList.contains("open")).toBe(true);
    // In order: words, a folded run, words, a folded run; the words are markdown, not step lines.
    const parts = [...steps.children].map((child) => child.className);
    expect(parts).toEqual(["step-prose markdown", "steps-run", "step-prose markdown", "steps-run"]);
    const prose = steps.querySelectorAll<HTMLElement>(".step-prose");
    expect(prose[0].querySelector("strong")?.textContent).toBe("tests");
    expect(prose[1].textContent).toContain("Two failed; fixing them.");
    expect(steps.querySelector(".step.text")).toBeNull();
    const runs = steps.querySelectorAll<HTMLElement>(".steps-run");
    expect(runs[0].querySelector(".steps-toggle")?.textContent).toBe("2 steps");
    expect(runs[1].querySelector(".steps-toggle")?.textContent).toBe("1 step");
    const list = runs[0].querySelector<HTMLElement>(".step-list")!;
    expect(list.hidden).toBe(true);
    runs[0].querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(list.hidden).toBe(false);
    expect(list.querySelectorAll(".step.tool")).toHaveLength(2);
    // Each run remembers being open on its own across a redraw.
    const again = messageElement(message({ id: "r-text", text: "All green.", steps: [
      step("t0", "text", "First I'll look at the **tests**."), step("a1", "tool", "Read Package.swift"), step("a2", "tool", "Run swift test"),
      step("t1", "text", "Two failed; fixing them."), step("b1", "tool", "Edit Trace.swift"),
    ] }), {});
    expect(again.querySelector<HTMLElement>(".steps-body")!.hidden).toBe(false);
    const lists = again.querySelectorAll<HTMLElement>(".steps-run > .step-list:first-of-type");
    expect(lists[0].hidden).toBe(false);
    expect(lists[1].hidden).toBe(true);
  });

  it("fold a finished turn's words and calls to one line, each reply remembering its own", () => {
    const step = (id: string, kind: "tool" | "text", title: string) =>
      ({ id, kind, tool: null, title, detail: null, output: null, failed: false, done: true, status: null, count: null });
    const steps = [step("n0", "text", "Looking."), step("n1", "tool", "Read a.swift")];
    const first = messageElement(message({ id: "fold-a", text: "Done.", steps }), {});
    const second = messageElement(message({ id: "fold-b", text: "Done.", steps }), {});
    expect(first.querySelector(".steps-toggle")?.textContent).toBe("Worked · 1 note · 1 step");
    expect(first.querySelector(".step-prose")?.closest<HTMLElement>(".steps-body")?.hidden).toBe(true);
    first.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(messageElement(message({ id: "fold-a", text: "Done.", steps }), {}).querySelector<HTMLElement>(".steps-body")!.hidden).toBe(false);
    expect(second.querySelector<HTMLElement>(".steps-body")!.hidden).toBe(true);
    first.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(messageElement(message({ id: "fold-a", text: "Done.", steps }), {}).querySelector<HTMLElement>(".steps-body")!.hidden).toBe(true);
  });

  it("show the words between tool calls while the bot is still at work", () => {
    const step = (id: string, kind: "tool" | "text", title: string, done = true) =>
      ({ id, kind, tool: null, title, detail: null, output: null, failed: false, done, status: null, count: null });
    const row = typingElement("", [
      step("l0", "tool", "Read a.swift"),
      step("l1", "text", "Found it; now the fix."),
      step("l2", "tool", "Edit a.swift", false),
    ]);
    const steps = row.querySelector<HTMLElement>(".steps.live")!;
    // While it works the whole process stays open, nothing folded behind one line.
    expect(steps.querySelector(".steps-body")).toBeNull();
    expect(steps.querySelector<HTMLElement>(".step-prose")!.closest("[hidden]")).toBeNull();
    expect(steps.querySelector(".step-prose")?.textContent).toContain("Found it; now the fix.");
    // Earlier calls fold to a chip; the calls under way stay in sight.
    const runs = steps.querySelectorAll<HTMLElement>(".steps-run");
    expect(runs[0].querySelector(".steps-toggle")?.textContent).toBe("1 step");
    expect(runs[0].querySelector<HTMLElement>(".step-list")!.hidden).toBe(true);
    const current = steps.lastElementChild as HTMLElement;
    expect(current.classList.contains("step-list")).toBe(true);
    expect(current.hidden).toBe(false);
    expect(current.querySelector(".step-title")?.textContent).toBe("Edit a.swift");
  });

  it("show the pictures a tool call gave back in its OUT box, in the lightbox on click", () => {
    const row = messageElement(message({ id: "r-img", text: "Looked.", steps: [
      { id: "p1", kind: "tool", tool: "Read", title: "Read login.png", detail: "/Users/me/login.png", output: "", failed: false, done: true, status: null, count: null,
        images: [{ url: "file:///Users/me/login.png", name: "login.png" }] },
    ] }), {});
    document.body.append(row);
    // Nothing loads while the step is closed.
    expect(row.querySelector("img.step-image")!.hasAttribute("src")).toBe(false);
    row.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    row.querySelector<HTMLButtonElement>(".step-head")!.click();
    const blocks = row.querySelectorAll<HTMLElement>(".step-block");
    expect(blocks[1].querySelector(".step-label")?.textContent).toBe("Out");
    const image = blocks[1].querySelector<HTMLImageElement>("img.step-image")!;
    expect(image.getAttribute("src")).toBe("file:///Users/me/login.png");
    expect(image.alt).toBe("login.png");
    // A picture and no words: no text box.
    expect(blocks[1].querySelector("pre")).toBeNull();
    image.click();
    // Seen large in the lightbox over the chat, not in a window of its own.
    expect(sent).toEqual([]);
    expect(document.querySelector(".lightbox .lightbox-image")?.getAttribute("src")).toBe("file:///Users/me/login.png");
    document.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
  });

  it("show a picture's small copy in the step, and the full one in the lightbox on click", () => {
    const row = messageElement(message({ id: "r-thumb", text: "Looked.", steps: [
      { id: "p2", kind: "tool", tool: "Bash", title: "screenshot", detail: null, output: "", failed: false, done: true, status: null, count: null,
        images: [{ url: "file:///chat/step-images/a.jpg", name: "a.jpg", thumb: "file:///chat/step-images/thumbs/a.jpg" }] },
    ] }), {});
    document.body.append(row);
    row.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    row.querySelector<HTMLButtonElement>(".step-head")!.click();
    const image = row.querySelector<HTMLImageElement>("img.step-image")!;
    expect(image.getAttribute("src")).toBe("file:///chat/step-images/thumbs/a.jpg");
    image.click();
    expect(document.querySelector(".lightbox .lightbox-image")?.getAttribute("src")).toBe("file:///chat/step-images/a.jpg");
    document.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
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

  it("offers the short list after @, searches every bot once you type, and lists them all after @@", () => {
    const composer = new Composer(document.body);
    const all = ["Main bot", "Maintainer", "laas", "garden", "lab notes", "a", "b", "c", "d", "e"];
    composer.update(state({ mentions: ["Main bot", "Maintainer"], allMentions: all } as Partial<ChatState>));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    const names = () => [...list.querySelectorAll("button")].map((b) => b.querySelector(".mention-name")?.textContent);
    composer.insert("@");
    expect(names()).toEqual(["@Main bot", "@Maintainer"]);
    composer.setText("");
    composer.insert("@la");
    expect(names()).toEqual(["@laas", "@lab notes"]);
    composer.setText("");
    composer.insert("@ma");
    expect(names()).toEqual(["@Main bot", "@Maintainer"]);
    composer.setText("");
    composer.insert("@@");
    expect(names()).toEqual(all.map((name) => "@" + name));
    composer.insert("g");
    expect(names()).toEqual(["@garden"]);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    composer.view.contentDOM.dispatchEvent(enter);
    expect(composer.text).toBe("@garden ");
    composer.setText("Hi ");
    composer.insert("@la");
    composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(composer.text).toBe("Hi @laas ");
  });

  it("offers only bots after @, never components", () => {
    const composer = new Composer(document.body);
    // A one-to-one chat: the bots you can call in, but no components.
    composer.update(state({ mentions: ["Main bot", "Maintainer", "garden"], slashComponents: ["choices", "網頁預覽卡片"], componentMentions: ["choices", "網頁預覽卡片"] } as Partial<ChatState>));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    composer.insert("@");
    expect([...list.querySelectorAll("button")].map((b) => b.querySelector(".mention-name")?.textContent)).toEqual(["@Main bot", "@Maintainer", "@garden"]);
    composer.setText("");
    composer.insert("看這個@網");
    expect(list.hidden).toBe(true);
  });

  it("offers commands after a bare /, components only once a letter follows, and puts the picked one in", () => {
    const composer = new Composer(document.body);
    composer.update(state({
      mentions: ["garden"],
      slashCommands: [{ name: "design", about: "Make a Claude Design" }],
      slashComponents: ["choices", "網頁預覽卡片", "design", "dash", "diff", "deck", "demo", "dial", "dot"],
    }));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    const names = () => [...list.querySelectorAll("button")].map((b) => b.querySelector(".mention-name")?.textContent);
    composer.insert("/");
    // A bare / is quiet: the app's commands only, no components.
    expect(list.hidden).toBe(false);
    expect(list.classList.contains("slash")).toBe(true);
    expect(names()).toEqual(["/design"]);
    // No tag on the row; the kind is at most a faint hint.
    expect(list.querySelector(".mention-kind")).toBeNull();
    // A letter after it brings in the matching components; a component named like a command is
    // offered once, as the command; five at most.
    composer.insert("d");
    expect(names()).toEqual(["/design", "/dash", "/diff", "/deck", "/demo"]);
    composer.setText("");
    composer.insert("/網");
    expect(names()).toEqual(["/網頁預覽卡片"]);
    // Up/Down move, Return puts it in.
    const key = (k: string) => composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    composer.setText("");
    composer.insert("/c");
    expect(names()).toEqual(["/choices"]);
    key("Enter");
    expect(composer.text).toBe("/choices ");
    expect(sent).toEqual([]);
    composer.setText("");
    composer.insert("/d");
    key("ArrowDown");
    key("ArrowDown");
    expect(list.querySelector("button.active .mention-name")?.textContent).toBe("/diff");
    key("ArrowUp");
    expect(list.querySelector("button.active .mention-name")?.textContent).toBe("/dash");
    key("Enter");
    expect(composer.text).toBe("/dash ");
    // Typed after other words, and filtered by what follows the slash; Tab picks too.
    composer.setText("");
    composer.insert("請做 /des");
    expect(names()).toEqual(["/design"]);
    key("Tab");
    expect(composer.text).toBe("請做 /design ");
    // Inside a word or a path it is just a slash; Escape closes the list.
    composer.setText("");
    composer.insert("a/b");
    expect(list.hidden).toBe(true);
    composer.setText("");
    composer.insert("see ~/de");
    expect(list.hidden).toBe(true);
    composer.setText("");
    composer.insert("/");
    key("Escape");
    expect(list.hidden).toBe(true);
    // @ still offers the bots, not components, in the ordinary list.
    composer.setText("");
    composer.insert("@");
    expect(names()).toEqual(["@garden"]);
    expect(list.classList.contains("slash")).toBe(false);
  });

  it("keeps a bare / silent when there are components but no commands", () => {
    const composer = new Composer(document.body);
    composer.update(state({ slashComponents: ["choices"] }));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    composer.insert("/");
    expect(list.hidden).toBe(true);
    composer.insert("c");
    expect(list.hidden).toBe(false);
  });

  it("offers the bot's own components first, then the shared library's, marked faintly", () => {
    const composer = new Composer(document.body);
    composer.update(state({ slashComponents: ["weather"], slashLibrary: ["wave", "weather", "wide"] } as Partial<ChatState>));
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    composer.insert("/w");
    const rows = [...list.querySelectorAll("button")];
    expect(rows.map((b) => b.querySelector(".mention-name")?.textContent)).toEqual(["/weather", "/wave", "/wide"]);
    expect(rows.map((b) => b.classList.contains("library"))).toEqual([false, true, true]);
    expect(rows[1].querySelector(".mention-hint")?.textContent).toBe("library");
    expect(rows[1].getAttribute("aria-label")).toBe("/wave, component in the shared library");
    expect(rows[0].querySelector(".mention-hint")).toBeNull();
  });

  it("shows the / list wide enough to read: whole names, descriptions wrap instead of being cut", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    document.head.append(style);
    try {
      const composer = new Composer(document.body);
      composer.update(state({ slashCommands: [{ name: "design", about: "Make a Claude Design and get its claude.ai link" }] }));
      composer.insert("/");
      const list = document.querySelector<HTMLElement>(".mention-list.slash")!;
      const name = list.querySelector<HTMLElement>(".mention-name")!;
      const hint = list.querySelector<HTMLElement>(".mention-hint")!;
      expect(hint.textContent).toBe("Make a Claude Design and get its claude.ai link");
      // The command's name is never shortened to "/des…".
      expect(getComputedStyle(name).textOverflow).not.toBe("ellipsis");
      expect(getComputedStyle(name).flexShrink).toBe("0");
      // The description goes on a muted line of its own and wraps rather than being clipped.
      expect(getComputedStyle(hint).whiteSpace).not.toBe("nowrap");
      expect(getComputedStyle(hint).textOverflow).not.toBe("ellipsis");
      // A real width, up to the composer's, not a 160–280px box.
      const box = getComputedStyle(list);
      expect(box.minWidth).toContain("360px");
      expect(box.maxWidth).toContain("100%");
    } finally {
      style.remove();
    }
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
