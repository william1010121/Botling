/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { componentPage, keepFrames } from "../src/components";
import { messageElement } from "../src/messages";
import { PinArea } from "../src/pins";
import type { ChatState, ComponentInfo, DisplayView, MessageView, PinView } from "../src/types";

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

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "ClaudeCodeBot", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, pins: [], pinChoices: [], board: false, ...overrides,
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
  sent.length = 0;
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("ccb.save in the frame", () => {
  it("posts the data as JSON and becomes the new ccb.data", async () => {
    const { ccb, posted } = run(componentPage("<p></p>", first, {}, "2x2", "chat", false, true));
    const next = { items: [{ text: "Milk", done: true }] };
    await ccb.save(next);
    expect(posted).toEqual([{ ccb: "save", data: JSON.stringify(next) }]);
    // A copy: changing the object afterwards does not change what was saved.
    expect(ccb.data).toEqual(next);
    expect(ccb.data).not.toBe(next);
  });

  it("refuses what cannot be kept, and where nothing is kept", async () => {
    const { ccb, posted } = run(componentPage("<p></p>", first, {}, "2x2", "chat", false, true));
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await expect(ccb.save(loop)).rejects.toThrow();
    await expect(ccb.save(undefined)).rejects.toThrow();
    await expect(ccb.save(null)).rejects.toThrow();
    await expect(ccb.save("x".repeat(256 * 1024))).rejects.toThrow(/too big/);
    expect(posted).toEqual([]);
    // A frame that cannot save (a command's card, a preview) says so.
    const readOnly = run(componentPage("<p></p>", first));
    await expect(readOnly.ccb.save({ items: [] })).rejects.toThrow(/cannot save/);
    expect(readOnly.posted).toEqual([]);
  });
});

describe("a chat component's saved data", () => {
  it("goes to Swift with its message and place, and the redraw keeps its frame", () => {
    const row = messageElement(message([{ name: "todo", data: first }, { name: "todo", data: first }]), components);
    document.body.append(row);
    const frames = row.querySelectorAll<HTMLIFrameElement>(".component-frame");
    expect(frames[0].srcdoc).toContain("save(");
    say(frames[1], { ccb: "save", data: ticked });
    say(frames[1], { ccb: "save", data: 42 });
    expect(sent).toEqual([{ type: "componentSave", messageID: "m1", index: 1, data: ticked }]);

    // Swift sends the message back with the saved data: the frame that saved it is not reloaded.
    const fresh = messageElement(message([{ name: "todo", data: first }, { name: "todo", data: ticked }]), components);
    const kept = keepFrames(row, fresh);
    expect(kept).toBe(row);
    expect(row.querySelectorAll(".component-frame")[1]).toBe(frames[1]);
    // Data changed some other way still draws again.
    const other = messageElement(message([{ name: "todo", data: first }, { name: "todo", data: "{}" }]), components);
    keepFrames(row, other);
    expect(row.querySelectorAll(".component-frame")[1]).not.toBe(frames[1]);
  });

  it("a card whose data comes from a command does not save", () => {
    const row = messageElement(message([{ name: "stats", data: "{}", command: "echo {}", folder: "/p", status: "done" }]), components);
    document.body.append(row);
    const frame = row.querySelector<HTMLIFrameElement>(".component-frame")!;
    say(frame, { ccb: "save", data: ticked });
    expect(sent).toEqual([]);
  });
});

describe("a pinned component's saved data", () => {
  function setUp(): PinArea {
    document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
    return new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
  }

  it("a Board tile saves to its pin and keeps its frame when the pin comes back", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin()] }));
    sent.length = 0;
    const frame = document.querySelector<HTMLIFrameElement>(".board-card .component-frame")!;
    say(frame, { ccb: "save", data: ticked });
    expect(sent).toEqual([{ type: "pinSave", id: "P1", data: ticked }]);
    area.update(state({ board: true, pins: [pin({ display: { name: "todo", data: ticked }, headline: "Milk · Eggs" })] }));
    expect(document.querySelector(".board-card .component-frame")).toBe(frame);
  });

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

    // The Board's tile, drawn before with the old data, draws again with the saved data.
    area.update(state({ board: true, pins: [pin()] }));
    const tile = document.querySelector<HTMLIFrameElement>(".board-card .component-frame")!;
    // Back to the chat: the pin is still open above the input box.
    area.update(state({ board: false, pins: [pin()] }));
    say(document.querySelector<HTMLIFrameElement>(".pin-sheet .component-frame")!, { ccb: "save", data: ticked });
    area.update(state({ board: true, pins: [pin({ display: { name: "todo", data: ticked } })] }));
    const redrawn = document.querySelector<HTMLIFrameElement>(".board-card .component-frame")!;
    expect(redrawn).not.toBe(tile);
    expect(redrawn.srcdoc).toContain("Eggs");

    const board = setUp();
    board.update(state({ board: true, pins: [pin({ id: "P2", name: "stats", display: { name: "stats", data: "{}", command: "echo {}", folder: "/p", status: "done" } })] }));
    sent.length = 0;
    say(document.querySelector<HTMLIFrameElement>(".board-card .component-frame")!, { ccb: "save", data: ticked });
    expect(sent).toEqual([]);
  });
});
