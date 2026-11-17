// @vitest-environment jsdom
/// <reference types="node" />
// botling.component-studio's web part in the chat page, run by the page's own PluginHost (so `ccb.draw`, the decorations, `ccb.call` and
// `ccb.requestApproval` are the real ones): the chips under a reply, the built component with Undo / Restore, a command that
// asks for your OK. There is no spec panel (nor an Edit spec button) any more: the per-message button of the chat page sends a message to the bot.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import { Composer } from "../../../../Web/src/composer";
import { extensions, messageElement } from "../../../../Web/src/messages";
import { PluginHost, studioSeam, type PluginSpec } from "../../../../Web/src/plugins";
import type { ChatState, ComponentInfo, DisplayView, MessageView, SpecChipView } from "../../../../Web/src/types";
import { readChatCss } from "../../../../Web/test/helpers/chat-css";
import { activate } from "../src/web";

globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NAME = "botling.component-studio";
const components: Record<string, ComponentInfo> = {
  "test-summary": { template: "<div>tests</div>", version: 1, working: false, updated: false, hasPrevious: false },
};
const display = (more: Partial<DisplayView> = {}): DisplayView => ({ name: "test-summary", data: '{"total":382}', at: null, ...more });
const chip = (more: Partial<SpecChipView> = {}): SpecChipView => ({ id: "S1", name: "test-summary", status: "draft", suggested: false, ...more });

function message(id: string, more: Partial<MessageView> = {}): MessageView {
  return {
    id, role: "bot", text: "382 passed, 0 failed.", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false,
    attachments: null, replyTo: null, replyPreview: null, openable: false, ...more,
  } as MessageView;
}

let host: PluginHost;
let scroller: HTMLElement;
let wide: ((state: ChatState) => void) | null = null;

/** The chat as the page has it: the replies drawn, and the plugin's decorations placed. */
function draw(specs: Record<string, SpecChipView[]>, replies: string[] = Object.keys(specs)) {
  scroller.innerHTML = "";
  for (const id of replies) scroller.append(messageElement(message(id), components));
  const state = {
    botID: "main", botName: "Main", working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components, messages: replies.map((id) => message(id)),
    decorations: Object.entries(specs).map(([id, list]) => ({ plugin: NAME, key: `specs/${id}`, under: id, data: { specs: list } })),
  } as unknown as ChatState;
  host.decorations.update(state, (id) => scroller.querySelector<HTMLElement>(`.row[data-id="${id}"]`));
  wide?.(state);
  return scroller;
}

/** Answers the page's next ask of the program part the way the program part would. */
function answerCalls(answers: Record<string, unknown>) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  let done = 0;
  const pump = () => {
    for (; done < sent.length; done++) {
      const action = sent[done] as { type: string; method?: string; params?: Record<string, unknown>; callID: number };
      if (action.type === "hostCall") {
        asked.push({ method: action.method!, params: action.params ?? {} });
        const answer = answers[action.method!];
        host.hostReply(action.callID, true, typeof answer === "function" ? (answer as (params: unknown) => unknown)(action.params) : answer ?? null);
      } else if (action.type === "pluginApproval") {
        asked.push({ method: "approval", params: action as never });
        host.hostReply(action.callID, true, answers.approval ?? { allowed: false });
      }
    }
  };
  return { asked, pump };
}
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); };

beforeEach(async () => {
  sent.length = 0;
  document.body.innerHTML = `<main id="messages"></main>`;
  scroller = document.getElementById("messages")!;
  const composer = new Composer(document.body.appendChild(document.createElement("div")));
  host = new PluginHost({
    composer: { element: composer.root, view: composer.view, getText: () => composer.text, insert: (text) => composer.insert(text), addExtension: (extension) => composer.addExtension(extension), showPopover: (content) => composer.showPopover(content), mentionSource: (source) => composer.addMentionSource(source), chips: { add: (item) => composer.addChip(item), list: () => composer.chipsHere() } },
    redraw: () => {},
  });
  const spec: PluginSpec = { name: NAME, version: "1.0.0", source: "", styles: [], settings: {}, commands: [], builtIn: true } as PluginSpec;
  await host.sync([spec], async () => activate);
  sent.length = 0;
});
afterEach(() => { wide = null; document.documentElement.lang = "en"; });

describe("the chips under a reply", () => {
  it("a chip being built says Building…, and pressing it asks the program part to press it", async () => {
    const page = draw({ m1: [chip({ status: "building" })] });
    const strip = page.querySelector(".row[data-id='m1'] .decoration-extra .spec-chips")!;
    const button = strip.querySelector<HTMLButtonElement>(".spec-chip")!;
    expect(button.textContent).toContain("Building… · test-summary");
    expect(button.querySelector(".spinner")).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.click();
    expect(sent).toEqual([{ type: "hostCall", plugin: NAME, method: "press", params: { id: "S1" }, callID: expect.any(Number) }]);
  });

  it("is drawn in the reply's own column, under its words, as the chat drew it before", () => {
    const page = draw({ m1: [chip({ status: "building" })] });
    const row = page.querySelector<HTMLElement>(".row[data-id='m1']")!;
    const column = row.querySelector<HTMLElement>(":scope > .bot-column")!;
    expect([...column.children].map((el) => el.className)).toEqual(["bubble bot-bubble", "decoration-extra spec-decoration"].map((c) => expect.stringContaining(c.split(" ")[0]!)));
    expect(column.lastElementChild!.querySelector(".spec-chips")).not.toBeNull();
  });

  it("a bot's suggestion is only a chip: nothing is built or drawn until pressed", () => {
    const page = draw({ m1: [chip({ suggested: true })] });
    const button = page.querySelector<HTMLButtonElement>(".spec-chip")!;
    expect(button.textContent).toContain("Suggested component · test-summary");
    expect(page.querySelector(".spec-edit")).toBeNull();
    expect(page.querySelector(".spec-built")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("once built, the component itself shows under the reply with Undo (no Edit spec), and takes the whole column", () => {
    const page = draw({ m1: [chip({ status: "done", component: "test-summary", display: display(), undo: "undo" })] });
    expect(page.querySelector(".spec-chip")).toBeNull();
    const built = page.querySelector<HTMLElement>(".spec-built")!;
    expect(built.textContent).toContain("Component · test-summary");
    expect(built.querySelector<HTMLIFrameElement>("iframe")!.srcdoc).toContain("<div>tests</div>");
    expect([...built.querySelectorAll(".spec-built-head button")].map((b) => b.textContent)).toEqual(["Undo"]);
    const row = page.querySelector<HTMLElement>(".row[data-id='m1']")!;
    expect(row.classList.contains("wide")).toBe(true);
    expect(row.querySelector(".bot-column")!.classList.contains("tiled")).toBe(true);
    built.querySelector<HTMLButtonElement>(".spec-undo")!.click();
    expect(sent.map((action) => (action as { method?: string }).method)).toEqual(["undo"]);
  });

  it("an undone one offers Restore beside its chip", () => {
    const page = draw({ m1: [chip({ status: "done", undo: "restore" })] });
    const restore = page.querySelector<HTMLButtonElement>(".spec-undo")!;
    expect(restore.textContent).toBe("Restore");
    restore.click();
    expect(sent.at(-1)).toMatchObject({ type: "hostCall", method: "restore", params: { id: "S1" } });
  });

  it("a new version being built keeps the component, saying so", () => {
    const page = draw({ m1: [chip({ status: "building", component: "test-summary", display: display() })] });
    const built = page.querySelector(".spec-built")!;
    expect(built.textContent).toContain("Building a new version");
    expect(built.querySelector("button")).toBeNull();
  });

  it("the Board's pin button joins the head of a built component, when that plugin is on", () => {
    const pin = document.createElement("button");
    pin.setAttribute("aria-label", "Pin to this bot");
    const registered = { plugin: "botling.board", make: (spec: SpecChipView) => (spec.id === "S1" ? pin : null) };
    studioSeam.specButtons.push(registered);
    try {
      const page = draw({ m1: [chip({ status: "done", component: "test-summary", display: display() })] });
      expect(page.querySelector(".spec-built-head [aria-label='Pin to this bot']")).toBe(pin);
    } finally {
      studioSeam.specButtons.splice(studioSeam.specButtons.indexOf(registered), 1);
    }
  });

  it("when the tile goes away the reply is as wide as its own words say", () => {
    draw({ m1: [chip({ status: "done", component: "test-summary", display: display() })] });
    expect(scroller.querySelector(".row")!.classList.contains("wide")).toBe(true);
    draw({ m1: [] }, ["m1"]);
    expect(scroller.querySelector(".spec-built")).toBeNull();
  });
});

describe("a built component's command", () => {
  const cardDisplay = () => display({ command: "swift test --parallel", folder: "/Users/me/p", status: "approve", data: "null" });

  it("asks with the exact command and folder; Allow asks the program part, then the app's sheet, then runs it", async () => {
    const page = draw({ m1: [chip({ status: "done", component: "test-summary", display: cardDisplay() })] });
    const ask = page.querySelector(".spec-built .command-approve")!;
    expect(ask.textContent).toContain("/Users/me/p");
    expect(ask.querySelector(".command-full")?.textContent).toBe("swift test --parallel");
    // Nothing runs on its own.
    expect(sent).toEqual([]);
    const program = answerCalls({
      command: (() => { let first = true; return () => { const answer = first ? { accepted: false, needsApproval: { command: "swift test --parallel", folder: "/Users/me/p", detail: null, card: "test-summary" } } : { accepted: true }; first = false; return answer; }; })(),
      approval: { allowed: true },
    });
    ask.querySelector<HTMLButtonElement>(".command-allow")!.click();
    program.pump();
    await settle();
    program.pump();
    await settle();
    program.pump();
    expect(program.asked.map((entry) => entry.method)).toEqual(["command", "approval", "command"]);
    expect(program.asked[0]!.params).toEqual({ id: "S1", command: "swift test --parallel", folder: "/Users/me/p" });
    expect(program.asked[1]!.params).toMatchObject({ plugin: NAME, botId: "main", command: "swift test --parallel", folder: "/Users/me/p", card: "test-summary" });
    expect(program.asked[2]!.params).toEqual({ id: "S1", command: "swift test --parallel", folder: "/Users/me/p" });
  });

  it("a refused sheet runs nothing", async () => {
    const page = draw({ m1: [chip({ status: "done", component: "test-summary", display: cardDisplay() })] });
    const program = answerCalls({ command: { accepted: false, needsApproval: { command: "swift test --parallel", folder: "/Users/me/p", detail: null, card: "test-summary" } }, approval: { allowed: false } });
    page.querySelector<HTMLButtonElement>(".spec-built .command-allow")!.click();
    program.pump();
    await settle();
    program.pump();
    await settle();
    expect(program.asked.map((entry) => entry.method)).toEqual(["command", "approval"]);
  });
});

describe("no spec panel", () => {
  it("registers no right-panel view and no panel-mode renderer, and no 'Component spec' words", () => {
    expect(extensions.panels.has(`${NAME}/${NAME}.spec`)).toBe(false);
    expect([...extensions.panels.keys()].filter((key) => key.startsWith(`${NAME}/`))).toEqual([]);
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
    expect(manifest.contributes?.views).toBeUndefined();
    expect(manifest.contributes?.commands ?? []).toEqual([]);
    expect(manifest.contributes?.menus ?? {}).toEqual({});
    expect(readFileSync(resolve(__dirname, "../studio.css"), "utf8")).not.toMatch(/\.spec-panel|\.spec-test-run|\.spec-title/);
  });
});

describe("the stylesheet", () => {
  it("draws the chips with the plugin's own rules (moved out of chat.css)", () => {
    const css = readFileSync(resolve(__dirname, "../studio.css"), "utf8");
    for (const selector of [".spec-chip", ".spec-built", ".bot-column.tiled"]) expect(css).toContain(selector);
    expect(readChatCss()).not.toMatch(/\.spec-(chip|built)\b/);
  });
});
