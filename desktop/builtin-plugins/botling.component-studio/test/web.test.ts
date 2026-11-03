// @vitest-environment jsdom
/// <reference types="node" />
// botling.component-studio's web part in the chat page, run by the page's own PluginHost (so `ccb.draw`, the decorations, `ccb.call` and
// `ccb.requestApproval` are the real ones): the chips under a reply, the built component with Edit spec and Undo / Restore, a command that
// asks for your OK, and the spec panel of the page's panel mode, fed by what the program part pushes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import { Composer } from "../../../../Web/src/composer";
import { extensions, messageElement } from "../../../../Web/src/messages";
import { PluginHost, type PluginSpec } from "../../../../Web/src/plugins";
import type { ChatState, ComponentInfo, DisplayView, MessageView, SpecChipView } from "../../../../Web/src/types";
import { activate, VIEW } from "../src/web";
import type { SpecState } from "../src/types";

globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NAME = "botling.component-studio";
const components: Record<string, ComponentInfo> = {
  "test-summary": { template: "<div>tests</div>", version: 1, working: false, updated: false, hasPrevious: false },
};
const display = (more: Partial<DisplayView> = {}): DisplayView => ({ name: "test-summary", data: '{"total":382}', at: null, ...more });
const chip = (more: Partial<SpecChipView> = {}): SpecChipView => ({ id: "S1", name: "test-summary", status: "draft", suggested: false, open: false, ...more });

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
    composer: { element: composer.root, view: composer.view, getText: () => composer.text, insert: (text) => composer.insert(text), addExtension: (extension) => composer.addExtension(extension), showPopover: (content) => composer.showPopover(content), chips: { add: (item) => composer.addChip(item), list: () => composer.chipsHere() } },
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

  it("once built, the component itself shows under the reply with Edit spec and Undo, and takes the whole column", () => {
    const page = draw({ m1: [chip({ status: "done", component: "test-summary", display: display(), undo: "undo" })] });
    expect(page.querySelector(".spec-chip")).toBeNull();
    const built = page.querySelector<HTMLElement>(".spec-built")!;
    expect(built.textContent).toContain("Component · test-summary");
    expect(built.querySelector<HTMLIFrameElement>("iframe")!.srcdoc).toContain("<div>tests</div>");
    expect([...built.querySelectorAll(".spec-built-head button")].map((b) => b.textContent)).toEqual(["Edit spec", "Undo"]);
    const row = page.querySelector<HTMLElement>(".row[data-id='m1']")!;
    expect(row.classList.contains("wide")).toBe(true);
    expect(row.querySelector(".bot-column")!.classList.contains("tiled")).toBe(true);
    built.querySelector<HTMLButtonElement>(".spec-edit:not(.spec-undo)")!.click();
    built.querySelector<HTMLButtonElement>(".spec-undo")!.click();
    expect(sent.map((action) => (action as { method?: string }).method)).toEqual(["open", "undo"]);
  });

  it("an undone one offers Restore beside its chip", () => {
    const page = draw({ m1: [chip({ status: "done", undo: "restore" })] });
    const restore = page.querySelector<HTMLButtonElement>(".spec-undo")!;
    expect(restore.textContent).toBe("Restore");
    restore.click();
    expect(sent.at(-1)).toMatchObject({ type: "hostCall", method: "restore", params: { id: "S1" } });
  });

  it("a new version being built keeps the component, saying so", () => {
    const page = draw({ m1: [chip({ status: "building", open: true, component: "test-summary", display: display() })] });
    const built = page.querySelector(".spec-built")!;
    expect(built.textContent).toContain("Building a new version");
    expect(built.querySelector(".spec-edit")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("the Board's pin button joins the head of a built component, when that plugin is on", () => {
    const pin = document.createElement("button");
    pin.setAttribute("aria-label", "Pin to this bot");
    const registered = { plugin: "botling.board", make: (spec: SpecChipView) => (spec.id === "S1" ? pin : null) };
    extensions.specButtons.push(registered);
    try {
      const page = draw({ m1: [chip({ status: "done", component: "test-summary", display: display() })] });
      expect(page.querySelector(".spec-built-head [aria-label='Pin to this bot']")).toBe(pin);
    } finally {
      extensions.specButtons.splice(extensions.specButtons.indexOf(registered), 1);
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

describe("the spec panel (the chat page's panel mode)", () => {
  function state(more: Partial<SpecState> = {}): SpecState {
    return {
      id: "S1", name: "test-summary", about: "Test results", status: "draft", draft: 1, chat: "Main bot", from: "from Main bot's reply", suggestedBy: null, existing: null,
      fields: [], command: null, folder: "/p", refresh: "manual", minutes: 15, bots: [{ name: "Main bot", on: true }], similar: null, similarAbout: null, reuse: false,
      samples: [{ label: "This reply", kind: "reply", data: '{"total":1}' }], preferredSample: 0, questions: [], conversation: [], origins: {}, preview: null, components: {},
      testRun: null, steps: null, wide: false, ...more,
    };
  }

  it("registers its view, draws the spec the program part pushes, and asks for it when the page opens after the spec did", async () => {
    const key = `${NAME}/${VIEW}`;
    expect(extensions.panels.has(key)).toBe(true);
    document.body.innerHTML = `<div id="panel-root"></div>`;
    const root = document.getElementById("panel-root")!;
    // Asked for on open: the program part says what is open.
    const program = answerCalls({ state: { chat: "main", lang: "zh-Hant", state: state({ name: "disk-usage" }) } });
    extensions.panels.get(key)!.render(root);
    program.pump();
    await settle();
    expect(program.asked.map((entry) => entry.method)).toEqual(["state"]);
    expect(document.documentElement.lang).toBe("zh-Hant");
    expect(root.querySelector(".spec-panel")).not.toBeNull();
    expect(root.querySelector(".spec-name-tag")?.textContent).toBe("disk-usage");
    // Pushed (ui.emit): the panel follows.
    host.pluginEvent(NAME, "spec", { chat: "main", lang: "en", state: state({ name: "tests", status: "done", preview: null }) });
    expect(root.querySelector(".spec-title")?.textContent).toBe("tests");
    // Another plugin's push is not heard.
    host.pluginEvent("someone.else", "spec", { chat: "main", state: state({ name: "stolen", status: "done" }) });
    expect(root.querySelector(".spec-title")?.textContent).toBe("tests");
    // Collapse asks the program part to close it; a test run waits for the sheet, with the bot whose chat it is.
    root.querySelector<HTMLButtonElement>("[aria-label='Collapse to the chip']")!.click();
    expect(sent.at(-1)).toMatchObject({ type: "hostCall", method: "close" });
  });

  it("Test run asks the program part, then the sheet for that chat's bot, then runs it", async () => {
    const key = `${NAME}/${VIEW}`;
    document.body.innerHTML = `<div id="panel-root"></div>`;
    const root = document.getElementById("panel-root")!;
    const program = answerCalls({
      state: { chat: "B1", state: state({ command: "df -h", folder: "/p/site" }) },
      testRun: (() => { let first = true; return () => { const answer = first ? { accepted: false, needsApproval: { command: "df -h", folder: "/p/site", detail: null, card: "test-summary" } } : { accepted: true }; first = false; return answer; }; })(),
      approval: { allowed: true },
    });
    extensions.panels.get(key)!.render(root);
    program.pump();
    await settle();
    root.querySelector<HTMLButtonElement>(".spec-test-run")!.click();
    for (let i = 0; i < 3; i++) { program.pump(); await settle(); }
    expect(program.asked.map((entry) => entry.method)).toEqual(["state", "testRun", "approval", "testRun"]);
    expect(program.asked[2]!.params).toMatchObject({ botId: "B1", command: "df -h", folder: "/p/site" });
  });
});

describe("the stylesheet", () => {
  it("draws the chips and the panel with the plugin's own rules (moved out of chat.css)", () => {
    const css = readFileSync(resolve(__dirname, "../studio.css"), "utf8");
    for (const selector of [".spec-chip", ".spec-built", ".spec-panel", ".spec-block", ".bot-column.tiled"]) expect(css).toContain(selector);
    expect(readFileSync(resolve(__dirname, "../../../../Web/src/chat.css"), "utf8")).not.toMatch(/\.spec-(chip|built|panel|block)\b/);
  });
});
