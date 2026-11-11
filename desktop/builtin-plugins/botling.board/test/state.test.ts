// @vitest-environment jsdom
/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { componentPage, keepFrames } from "../../../../Web/src/components";
import { messageElement } from "../../../../Web/src/messages";
import { PinArea } from "../src/pins";
import { installBoard, sent } from "./support";
import type { ComponentInfo, DisplayView, MessageView } from "../../../../Web/src/types";
import type { PinView, BoardState } from "../src/types";

// A component that keeps its own state with ccb.save(data): a todo list whose ticks stay.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  todo: { template: "<ul></ul>", version: 1, working: false, updated: false, hasPrevious: false },
  stats: { template: "<pre></pre>", version: 1, working: false, updated: false, hasPrevious: false },
};

const first = JSON.stringify({ items: [{ text: "Milk", done: false }] });
const ticked = JSON.stringify({ items: [{ text: "Milk", done: true }, { text: "Eggs", done: false }] });

function message(displays: DisplayView[], overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "m1", role: "bot", text: "Your list:", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays,
    attachments: null, replyTo: null, replyPreview: null, openable: false, ...overrides,
  };
}

function pin(overrides: Partial<PinView> = {}): PinView {
  return {
    id: "P1", name: "todo", headline: "Milk", chip: { text: "Milk", tone: "neutral" }, size: "2x2", refresh: "manual", minutes: 15,
    display: { name: "todo", data: first },
    ...overrides,
  };
}

function state(overrides: Partial<BoardState> = {}): BoardState {
  return {
    botID: "b1", botName: "ClaudeCodeBot", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, pins: [], pinChoices: [], ...overrides,
  };
}

/** Runs a component page's ccb script against a fake frame, collecting what it posts. */
function run(page: string) {
  const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
  const posted: unknown[] = [];
  const frame = { addEventListener() {} } as unknown as { ccb: { data: unknown; save: (data: unknown) => Promise<void> } };
  new Function("window", "parent", script)(frame, { postMessage: (data: unknown) => posted.push(data) });
  return { ccb: frame.ccb, posted };
}

const say = (frame: HTMLIFrameElement, data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));

beforeEach(() => {
  installBoard();
  sent.length = 0;
  document.body.innerHTML = "";
  document.body.className = "";
});



describe("a pinned component's saved data", () => {
  function setUp(): PinArea {
    document.body.innerHTML = `<main id="scroller"></main><div id="pin-area"></div><div id="composer-slot"></div>`;
    return new PinArea(document.getElementById("pin-area")!);
  }

  it("an opened pin saves too; a pinned command's card does not", () => {
    const area = setUp();
    area.update(state({ pins: [pin()] }));
    (document.querySelector(".pin-chip") as HTMLElement).click();
    sent.length = 0;
    const frame = document.querySelector<HTMLIFrameElement>(".pin-sheet .component-frame")!;
    say(frame, { ccb: "save", data: ticked });
    expect(sent).toEqual([{ type: "pinSave", id: "P1", data: ticked }]);
    area.update(state({ pins: [pin({ display: { name: "todo", data: ticked } })] }));
    expect(document.querySelector(".pin-sheet .component-frame")).toBe(frame);

    const other = setUp();
    other.update(state({ pins: [pin({ id: "P2", name: "stats", display: { name: "stats", data: "{}", command: "echo {}", folder: "/p", status: "done" } })] }));
    (document.querySelector(".pin-chip") as HTMLElement).click();
    sent.length = 0;
    say(document.querySelector<HTMLIFrameElement>(".pin-sheet .component-frame")!, { ccb: "save", data: ticked });
    expect(sent).toEqual([]);
  });
});
