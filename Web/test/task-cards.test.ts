import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import type { ChatState, MessageView, TaskCardView } from "../src/types";
import { PluginHost, type CcbWeb, type PluginSpec } from "../src/plugins";

// Task cards in the chat: the chip under a reply of a task, the same chip in a plugin's decoration, and
// "Jump to chat" landing on the decoration that folds a reply. (A summary's chips: botling.catchup's tests.)

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
// jsdom has no CSS.escape; the ids here need none.
globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;

const taskID = "5E1D7A2C-1111-4222-8333-944455556666";
const card = (extra: Partial<TaskCardView> = {}): TaskCardView => ({ id: taskID, name: "Fix the board", state: "running", owner: "claude", ...extra });
const line = (id: string, role: MessageView["role"] = "bot", extra: Partial<MessageView> = {}): MessageView => ({
  id, role, text: `text ${id}`, stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false,
  attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra,
});

describe("the chip under a reply", () => {
  it("comes first in the footer, in its state's color, with how the task stands on the latest reply", () => {
    const row = messageElement(line("r1", "bot", { reactionEnabled: true, taskCards: [card({ detail: "Now: drawing card 2" })] }), {});
    const footer = row.querySelector(".message-footer")!;
    expect(footer.firstElementChild?.className).toBe("task-card-chips");
    const chip = footer.querySelector<HTMLButtonElement>(".task-card-chip")!;
    expect(chip.classList.contains("running")).toBe(true);
    expect(chip.dataset.taskId).toBe(taskID);
    expect(chip.querySelector(".task-card-mark")?.textContent).toBe("●");
    expect(chip.querySelector(".task-card-name")?.textContent).toBe("Fix the board · Now: drawing card 2");
    expect(chip.getAttribute("aria-label")).toBe("Task Fix the board: Running");
    expect(chip.closest(".bubble")).toBeNull();
  });

  it("shows each state and the open task, and stands alone without other footer parts", () => {
    const states: TaskCardView["state"][] = ["pending", "waiting", "done", "stopped", "stale"];
    const row = messageElement(line("r2", "bot", { taskCards: states.map((state, index) => card({ id: `t${index}`, state, selected: state === "waiting" })) }), {});
    const chips = [...row.querySelectorAll<HTMLElement>(".task-card-chip")];
    expect(chips.map((chip) => chip.querySelector(".task-card-mark")?.textContent)).toEqual(["○", "◐", "✓", "■", "!"]);
    expect(chips.map((chip) => [...chip.classList].filter((name) => name !== "task-card-chip"))).toEqual([["pending"], ["waiting", "selected"], ["done"], ["stopped"], ["stale"]]);
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");
    expect(row.querySelectorAll(".message-footer > *")).toHaveLength(1);
  });

  it("opens its task in the right panel when pressed", () => {
    const row = messageElement(line("r3", "bot", { taskCards: [card()] }), {});
    row.querySelector<HTMLButtonElement>(".task-card-chip")!.click();
    expect(sent.at(-1)).toEqual({ type: "selectTask", id: taskID });
  });

  it("keeps a task name as text, never markup", () => {
    const row = messageElement(line("r4", "bot", { taskCards: [card({ name: "<img src=x onerror=alert(1)>" })] }), {});
    expect(row.querySelector(".task-card-chip img")).toBeNull();
    expect(row.querySelector(".task-card-name")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("is styled like the background-work pills: 20px high, 11px words, radius 10", () => {
    const css = readFileSync(`${__dirname}/../src/chat.css`, "utf8");
    const rule = css.split(".task-card-chip {")[1]?.split("}")[0] ?? "";
    expect(rule).toMatch(/height: 20px/);
    expect(rule).toMatch(/font-size: 11px/);
    expect(rule).toMatch(/border-radius: 10px/);
  });
});

describe("a decoration that folds a task's reply", () => {
  // A plugin web part that draws a list with the chip of each task its decoration is about.
  const activate = (ccb: CcbWeb) => {
    ccb.decorations.register({ draw: (root, decoration) => { root.innerHTML = `<section class="fold-card"><ul>${(decoration.tasks ?? []).map((task) => `<li>${ccb.messages.taskChip(task, "task")}</li>`).join("")}</ul></section>`; } });
  };
  const state = (): ChatState => ({
    botID: "task-bot", botName: "botling", working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {},
    messages: [line("a", "user"), line("b", "bot", { taskCards: [card({ state: "done" })] }), line("c")],
    decorations: [{ plugin: "folder", key: "k", fold: ["b", "c"], tasks: [card({ state: "done" })], data: null }],
  });

  beforeAll(async () => {
    document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
    const sync = PluginHost.prototype.sync;
    PluginHost.prototype.sync = function (specs: PluginSpec[]) { return sync.call(this, specs, async () => activate as never); };
    await import("../src/main");
    await window.ccb.setPlugins([{ name: "folder", version: "1", source: "x", styles: [], settings: {}, commands: [] }]);
  });

  it("jumps to the item with the task's chip, flashes it, and leaves the reply folded", () => {
    window.ccb.setState(state());
    expect(document.querySelector('.row[data-id="b"]')?.classList.contains("decoration-folded")).toBe(true);
    window.ccb.jumpToTask("b", taskID);
    expect(document.querySelector(".fold-card li")!.classList.contains("flash")).toBe(true);
    expect(document.querySelector('.row[data-id="b"]')?.classList.contains("decoration-folded")).toBe(true);
  });

  it("opens the task when the chip is pressed (the page lends the chip; the plugin asks to open it)", () => {
    window.ccb.setState(state());
    expect(document.querySelector(".fold-card .task-card-chip")?.getAttribute("data-task-id")).toBe(taskID);
  });

  it("without the task's chip, flashes the decoration's card", () => {
    window.ccb.setState({ ...state(), decorations: [{ plugin: "folder", key: "k2", fold: ["b", "c"], tasks: null, data: null }] });
    window.ccb.jumpToTask("b", taskID);
    expect(document.querySelector(".fold-card")!.classList.contains("flash")).toBe(true);
  });
});
